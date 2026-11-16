package service

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const EngineeringCapacityFreshness = 30 * time.Second

// Capacity is one authenticated machine poll, shared across its runtime set.
// An online heartbeat is not evidence that the daemon has a free slot.
type EngineeringDispatchCapacity struct {
	mu     sync.Mutex
	groups map[string]engineeringCapacitySample
}
type engineeringCapacitySample struct {
	runtimes []db.AgentRuntime
	slots    int
	at       time.Time
}

func NewEngineeringDispatchCapacity() *EngineeringDispatchCapacity {
	return &EngineeringDispatchCapacity{groups: map[string]engineeringCapacitySample{}}
}
func engineeringCapacityGroup(r db.AgentRuntime) string {
	if !r.DaemonID.Valid || r.DaemonID.String == "" {
		return ""
	}
	return r.OwnerID.String() + ":" + r.DaemonID.String
}
func (c *EngineeringDispatchCapacity) Observe(runtimes []db.AgentRuntime, slots int, now time.Time) {
	if c == nil {
		return
	}
	if slots < 0 {
		slots = 0
	}
	groups := map[string][]db.AgentRuntime{}
	owners := map[string]map[pgtype.UUID]bool{}
	for _, r := range runtimes {
		key := engineeringCapacityGroup(r)
		if key != "" {
			groups[key] = append(groups[key], r)
			if owners[r.DaemonID.String] == nil {
				owners[r.DaemonID.String] = map[pgtype.UUID]bool{}
			}
			owners[r.DaemonID.String][r.OwnerID] = true
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, saved := range c.groups {
		if now.Sub(saved.at) > EngineeringCapacityFreshness {
			delete(c.groups, key)
		}
	}
	for key, rows := range groups {
		available := slots
		if len(owners[rows[0].DaemonID.String]) > 1 {
			available = 0
		}
		c.groups[key] = engineeringCapacitySample{runtimes: rows, slots: available, at: now}
	}
}
func (c *EngineeringDispatchCapacity) snapshot(r db.AgentRuntime, now time.Time) (engineeringCapacitySample, bool) {
	if c == nil {
		return engineeringCapacitySample{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.groups[engineeringCapacityGroup(r)]
	age := now.Sub(s.at)
	if !ok || s.slots <= 0 || age < 0 || age > EngineeringCapacityFreshness {
		return s, false
	}
	for _, member := range s.runtimes {
		if member.ID == r.ID && member.WorkspaceID == r.WorkspaceID && member.OwnerID == r.OwnerID && member.DaemonID == r.DaemonID && member.Visibility == r.Visibility {
			return s, true
		}
	}
	return s, false
}

type EngineeringDispatchReadiness struct {
	Runnable bool
	Reason   string
}

// Preview native queued selection without claims, tokens, notifications or
// provider access. In-flight claim preparation/reclaim retains a waiting barrier.
func (s *TaskService) InspectEngineeringDispatch(ctx context.Context, task db.AgentTaskQueue, now time.Time) (EngineeringDispatchReadiness, error) {
	wait := func(reason string) (EngineeringDispatchReadiness, error) {
		return EngineeringDispatchReadiness{Reason: reason}, nil
	}
	if task.Status != "queued" {
		return wait("native-task-not-queued")
	}
	runtime, err := s.Queries.GetAgentRuntime(ctx, task.RuntimeID)
	if err != nil {
		return EngineeringDispatchReadiness{}, err
	}
	sample, ok := s.EngineeringCapacity.snapshot(runtime, now)
	if !ok {
		return wait("daemon-capacity-unknown-or-full")
	}
	ids := make([]pgtype.UUID, 0, len(sample.runtimes))
	current := map[pgtype.UUID]db.AgentRuntime{}
	active := map[pgtype.UUID]int64{}
	for _, saved := range sample.runtimes {
		r, e := s.Queries.GetAgentRuntime(ctx, saved.ID)
		if e != nil {
			return EngineeringDispatchReadiness{}, e
		}
		if r.WorkspaceID != saved.WorkspaceID || r.OwnerID != saved.OwnerID || r.DaemonID != saved.DaemonID || r.Visibility != saved.Visibility {
			return wait("daemon-runtime-cohort-changed")
		}
		if r.Status != "online" {
			if r.ID == runtime.ID {
				return wait("runtime-offline")
			}
			continue
		}
		seen := r.UpdatedAt
		if r.LastSeenAt.Valid {
			seen = r.LastSeenAt
		}
		if !seen.Valid || now.Before(seen.Time) || now.Sub(seen.Time) > time.Duration(RuntimeClaimFreshnessSeconds)*time.Second {
			if r.ID == runtime.ID {
				return wait("runtime-stale")
			}
			continue
		}
		// Both singular and batch claim recover dispatched rows before queued
		// selection. Until that native preparation settles, do not invent slots.
		rows, e := s.Queries.ListPendingTasksByRuntime(ctx, r.ID)
		if e != nil {
			return EngineeringDispatchReadiness{}, e
		}
		for _, pending := range rows {
			if pending.Status == "dispatched" {
				return wait("native-claim-preparation")
			}
		}
		count, e := s.Queries.CountActiveTasksByRuntime(ctx, r.ID)
		if e != nil {
			return EngineeringDispatchReadiness{}, e
		}
		active[r.ID] = count
		current[r.ID] = r
		ids = append(ids, r.ID)
	}
	if len(ids) == 0 {
		return wait("runtime-not-available")
	}
	candidates, err := s.Queries.ListQueuedClaimCandidatesByRuntimes(ctx, ids)
	if err != nil {
		return EngineeringDispatchReadiness{}, err
	}
	tried := map[pgtype.UUID]bool{}
	selected := 0
	for _, candidate := range candidates {
		if selected >= sample.slots {
			break
		}
		if tried[candidate.AgentID] {
			continue
		}
		tried[candidate.AgentID] = true
		r := current[candidate.RuntimeID]
		if r.MaxConcurrentTasks.Valid && active[r.ID] >= int64(r.MaxConcurrentTasks.Int32) {
			continue
		}
		agent, e := s.Queries.GetAgent(ctx, candidate.AgentID)
		if e != nil {
			return EngineeringDispatchReadiness{}, e
		}
		if agent.RuntimeID != r.ID {
			continue
		}
		count, e := s.Queries.CountRunningTasks(ctx, agent.ID)
		if e != nil {
			return EngineeringDispatchReadiness{}, e
		}
		if count >= int64(agent.MaxConcurrentTasks) {
			continue
		}
		next, e := s.Queries.GetEngineeringNextClaimableTask(ctx, db.GetEngineeringNextClaimableTaskParams{AgentID: agent.ID, RuntimeID: r.ID, RuntimeStaleSecs: RuntimeClaimFreshnessSeconds})
		if errors.Is(e, pgx.ErrNoRows) {
			continue
		}
		if e != nil {
			return EngineeringDispatchReadiness{}, e
		}
		project, e := s.Queries.GetEngineeringTaskProject(ctx, db.GetEngineeringTaskProjectParams{TaskID: next.ID, WorkspaceID: r.WorkspaceID})
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return EngineeringDispatchReadiness{}, e
		}
		if e == nil {
			if _, e = s.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: r.WorkspaceID, ProjectID: project.ID}); e == nil {
				return wait("native-project-fence")
			} else if !errors.Is(e, pgx.ErrNoRows) {
				return EngineeringDispatchReadiness{}, e
			}
			reservations, e := s.Queries.ListEngineeringRepairHandoffReservations(ctx, db.ListEngineeringRepairHandoffReservationsParams{WorkspaceID: r.WorkspaceID, ProjectID: project.ID})
			if e != nil {
				return EngineeringDispatchReadiness{}, e
			}
			if len(reservations) > 0 {
				return wait("native-project-reservation")
			}
		}
		if next.ID == task.ID {
			return EngineeringDispatchReadiness{Runnable: true, Reason: "native-queued-selection"}, nil
		}
		selected++
		active[r.ID]++
	}
	return wait("native-capacity-serialization-or-priority")
}
