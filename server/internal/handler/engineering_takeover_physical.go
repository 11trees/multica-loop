package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering/ownership"
	"github.com/multica-ai/multica/server/internal/engineering/processidentity"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type engineeringRepairTaskTarget struct {
	ID         string `json:"id"`
	RuntimeID  string `json:"runtime_id"`
	Claim      int64  `json:"claim"`
	NoDispatch bool   `json:"no_dispatch"`
}
type engineeringRepairTargets struct {
	Version     int                           `json:"version"`
	Tasks       []engineeringRepairTaskTarget `json:"tasks"`
	Controllers []string                      `json:"controllers"`
	Allocations []string                      `json:"allocations"`
}

func engineeringTaskTargetKey(id, runtime string, claim int64) string {
	return id + ":" + runtime + ":" + strconv.FormatInt(claim, 10)
}

// Merge before cancellation so terminal tasks and old generations cannot hide writers.
func (h *Handler) recordEngineeringRepairTargets(ctx context.Context, fence db.EngineeringRepairFence) (engineeringRepairTargets, error) {
	var targets engineeringRepairTargets
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return targets, err
	}
	defer tx.Rollback(ctx)
	q := h.Queries.WithTx(tx)
	if _, err = q.LockEngineeringProject(ctx, db.LockEngineeringProjectParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID}); err != nil {
		return targets, err
	}
	current, err := q.LockEngineeringRepairFence(ctx, db.LockEngineeringRepairFenceParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID})
	if err != nil {
		return targets, err
	}
	if current.CaseID != fence.CaseID || current.AttemptID != fence.AttemptID || current.Generation != fence.Generation || current.OwnerID != fence.OwnerID || current.SupervisionToken != fence.SupervisionToken {
		return targets, fmt.Errorf("repair inventory owner changed")
	}
	if len(current.Targets) > 0 && string(current.Targets) != "{}" && string(current.Targets) != "[]" {
		if err = json.Unmarshal(current.Targets, &targets); err != nil {
			return targets, err
		}
		if targets.Version != 1 {
			return targets, fmt.Errorf("unsupported repair inventory version")
		}
	}
	targets.Version = 1
	tasks := map[string]engineeringRepairTaskTarget{}
	controllers := map[string]bool{}
	allocations := map[string]bool{}
	for _, target := range targets.Tasks {
		tasks[engineeringTaskTargetKey(target.ID, target.RuntimeID, target.Claim)] = target
	}
	for _, id := range targets.Controllers {
		controllers[id] = true
	}
	for _, id := range targets.Allocations {
		allocations[id] = true
	}
	writers, err := q.ListEngineeringProjectWriterTasks(ctx, db.ListEngineeringProjectWriterTasksParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID})
	if err != nil {
		return targets, err
	}
	for _, task := range writers {
		claim := int64(0)
		if task.DispatchedAt.Valid {
			claim = task.DispatchedAt.Time.UnixMicro()
		}
		target := engineeringRepairTaskTarget{ID: uuidToString(task.ID), RuntimeID: uuidToString(task.RuntimeID), Claim: claim, NoDispatch: !task.DispatchedAt.Valid && !task.StartedAt.Valid}
		tasks[engineeringTaskTargetKey(target.ID, target.RuntimeID, target.Claim)] = target
	}
	guards, err := q.ListEngineeringProjectControllers(ctx, db.ListEngineeringProjectControllersParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID})
	if err != nil {
		return targets, err
	}
	for _, guard := range guards {
		controllers[uuidToString(guard.ControllerID)] = true
		processes, e := q.ListEngineeringRunProcesses(ctx, db.ListEngineeringRunProcessesParams{WorkspaceID: fence.WorkspaceID, ControllerID: guard.ControllerID})
		if e != nil {
			return targets, e
		}
		for _, process := range processes {
			allocations[uuidToString(process.AllocationID)] = true
		}
	}
	targets.Tasks = nil
	targets.Controllers = nil
	targets.Allocations = nil
	for _, target := range tasks {
		targets.Tasks = append(targets.Tasks, target)
	}
	sort.Slice(targets.Tasks, func(i, j int) bool {
		a, b := targets.Tasks[i], targets.Tasks[j]
		return engineeringTaskTargetKey(a.ID, a.RuntimeID, a.Claim) < engineeringTaskTargetKey(b.ID, b.RuntimeID, b.Claim)
	})
	for id := range controllers {
		targets.Controllers = append(targets.Controllers, id)
	}
	sort.Strings(targets.Controllers)
	for id := range allocations {
		targets.Allocations = append(targets.Allocations, id)
	}
	sort.Strings(targets.Allocations)
	data, err := json.Marshal(targets)
	if err != nil {
		return targets, err
	}
	if _, err = q.SetEngineeringRepairFenceState(ctx, db.SetEngineeringRepairFenceStateParams{WorkspaceID: current.WorkspaceID, ProjectID: current.ProjectID, CaseID: current.CaseID, AttemptID: current.AttemptID, Generation: current.Generation, OwnerID: current.OwnerID, SupervisionToken: current.SupervisionToken, Phase: current.Phase, Targets: data}); err != nil {
		return targets, err
	}
	return targets, tx.Commit(ctx)
}

func (h *Handler) reconcileEngineeringPhysicalController(ctx context.Context, guard db.EngineeringRunGuard, validate func() error) error {
	processes, err := h.Queries.ListEngineeringRunProcesses(ctx, db.ListEngineeringRunProcessesParams{WorkspaceID: guard.WorkspaceID, ControllerID: guard.ControllerID})
	if err != nil {
		return err
	}
	host, hostErr := processidentity.HostID()
	for _, process := range processes {
		if process.Phase == "exited" {
			continue
		}
		confirmed := false
		pid := int64(0)
		if guard.Phase != "quiesced" && guard.NoProviderStarted.Valid && guard.NoProviderStarted.Bool && !process.Pid.Valid {
			confirmed = true
		}
		if guard.Phase != "quiesced" && hostErr == nil && guard.HostID == host && guard.Provider == "codex" && process.Pid.Valid && process.Pid.Int64 > 0 && process.Pid.Int64 != guard.ControllerPid && process.GroupID.Valid && process.GroupID.Int64 == process.Pid.Int64 && process.Marker.Valid && process.Marker.String != "" {
			if err = validate(); err != nil {
				return err
			}
			stopCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			confirmed = processidentity.StopRecorded(stopCtx, int(process.Pid.Int64), process.Marker.String)
			cancel()
			if err = validate(); err != nil {
				return err
			}
			pid = process.Pid.Int64
		}
		if confirmed {
			if err = validate(); err != nil {
				return err
			}
			if _, err = h.Queries.FinishEngineeringRunProcess(ctx, db.FinishEngineeringRunProcessParams{WorkspaceID: guard.WorkspaceID, ControllerID: guard.ControllerID, AllocationID: process.AllocationID, Pid: pgtype.Int8{Int64: pid, Valid: true}}); err != nil {
				return err
			}
		}
	}
	// A saved final-cleanup receipt is required even when every child is gone.
	if err = validate(); err != nil {
		return err
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := h.Queries.WithTx(tx)
	current, err := q.LockEngineeringRunGuard(ctx, db.LockEngineeringRunGuardParams{WorkspaceID: guard.WorkspaceID, ControllerID: guard.ControllerID})
	if err != nil {
		return err
	}
	if current.Phase != "unconfirmed" || !current.NoProviderStarted.Valid {
		return nil
	}
	processes, err = q.ListEngineeringRunProcesses(ctx, db.ListEngineeringRunProcessesParams{WorkspaceID: guard.WorkspaceID, ControllerID: guard.ControllerID})
	if err != nil {
		return err
	}
	if !ownership.ControllerCleanupConfirmed(current, processes) {
		return nil
	}

	if _, err = q.FinishEngineeringRunGuard(ctx, db.FinishEngineeringRunGuardParams{WorkspaceID: guard.WorkspaceID, ControllerID: guard.ControllerID, Phase: "quiesced", NoProviderStarted: current.NoProviderStarted}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type engineeringRepairProgress struct {
	Phase                 string  `json:"phase"`
	Cancelled             int     `json:"cancelled"`
	UnfinishedControllers int     `json:"unfinished_controllers"`
	UnknownTasks          int     `json:"unknown_tasks"`
	TargetsHash           string  `json:"targets_hash"`
	WorkspaceRoot         *string `json:"workspace_root"`
	SourceAttemptID       string  `json:"source_attempt_id"`
	SnapshotHash          string  `json:"snapshot_hash"`
}

func (h *Handler) finishEngineeringPhysicalDrain(ctx context.Context, fence db.EngineeringRepairFence, targets engineeringRepairTargets, cancelled int, validate func() error) (engineeringRepairProgress, error) {
	progress := engineeringRepairProgress{Phase: "draining", Cancelled: cancelled, SourceAttemptID: fence.SourceAttemptID, SnapshotHash: fence.SnapshotHash}
	data, err := json.Marshal(targets)
	if err != nil {
		return progress, err
	}
	digest := sha256.Sum256(data)
	progress.TargetsHash = hex.EncodeToString(digest[:])
	if err = validate(); err != nil {
		return progress, err
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return progress, err
	}
	defer tx.Rollback(ctx)
	q := h.Queries.WithTx(tx)
	if _, err = q.LockEngineeringProject(ctx, db.LockEngineeringProjectParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID}); err != nil {
		return progress, err
	}
	current, err := q.LockEngineeringRepairFence(ctx, db.LockEngineeringRepairFenceParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID})
	if err != nil {
		return progress, err
	}
	if current.AttemptID != fence.AttemptID || current.Generation != fence.Generation || current.OwnerID != fence.OwnerID || current.SupervisionToken != fence.SupervisionToken || string(current.Targets) != string(data) {
		// PostgreSQL JSONB normalizes whitespace and key order.
		var saved engineeringRepairTargets
		if json.Unmarshal(current.Targets, &saved) != nil {
			return progress, fmt.Errorf("repair inventory changed")
		}
		normalized, _ := json.Marshal(saved)
		if current.AttemptID != fence.AttemptID || current.Generation != fence.Generation || current.OwnerID != fence.OwnerID || current.SupervisionToken != fence.SupervisionToken || string(normalized) != string(data) {
			return progress, fmt.Errorf("repair inventory or owner changed")
		}
	}
	covered := map[string]bool{}
	seenAllocations := map[string]bool{}
	sourceController := false
	host, _ := processidentity.HostID()
	originalTask, originalClaim, ok := strings.Cut(fence.SourceAttemptID, ":")
	if !ok {
		return progress, fmt.Errorf("missing original source claim")
	}
	micros, err := strconv.ParseInt(originalClaim, 10, 64)
	if err != nil {
		return progress, err
	}
	raw, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-source", "actor": map[string]string{"kind": "host", "workspaceId": uuidToString(fence.WorkspaceID), "issueId": uuidToString(fence.IssueID)}, "payload": map[string]string{"case_id": fence.CaseID, "observation_id": fence.ObservationID, "snapshot_hash": fence.SnapshotHash}})
	if err != nil {
		return progress, err
	}
	var source engineeringTakeoverSource
	if err = json.Unmarshal(raw, &source); err != nil {
		return progress, err
	}
	for _, id := range targets.Controllers {
		controller, err := util.ParseUUID(id)
		if err != nil {
			return progress, err
		}
		guard, err := q.GetEngineeringRunGuard(ctx, db.GetEngineeringRunGuardParams{WorkspaceID: fence.WorkspaceID, ControllerID: controller})
		if err != nil {
			return progress, err
		}
		if guard.ProjectID != fence.ProjectID {
			return progress, fmt.Errorf("controller project changed")
		}
		processes, err := q.ListEngineeringRunProcesses(ctx, db.ListEngineeringRunProcessesParams{WorkspaceID: fence.WorkspaceID, ControllerID: controller})
		if err != nil {
			return progress, err
		}
		quiet := guard.Phase == "quiesced" && ownership.ControllerCleanupConfirmed(guard, processes)
		for _, process := range processes {
			seenAllocations[uuidToString(process.AllocationID)] = true
			quiet = quiet && process.Phase == "exited"
		}

		if !quiet {
			progress.UnfinishedControllers++
		} else {
			covered[engineeringTaskTargetKey(uuidToString(guard.TaskID), uuidToString(guard.RuntimeID), guard.ClaimAt.Time.UnixMicro())] = true
		}
		if uuidToString(guard.TaskID) == originalTask && guard.ClaimAt.Time.UnixMicro() == micros && guard.ScopeKind.String == "issue" && guard.ScopeID == fence.IssueID && guard.HostID == host && guard.WorkspacePath.Valid && guard.WorkspacePath.String == source.ExecutionPath && guard.ExecutionMode.String == source.Mode && quiet {
			sourceController = true
		}
	}
	for _, id := range targets.Allocations {
		if !seenAllocations[id] {
			return progress, fmt.Errorf("original process allocation disappeared")
		}
	}
	sourceUnknown := false
	for _, task := range targets.Tasks {
		if !task.NoDispatch && !covered[engineeringTaskTargetKey(task.ID, task.RuntimeID, task.Claim)] {
			progress.UnknownTasks++
			if task.ID == originalTask && task.Claim == micros {
				sourceUnknown = true
			}
		}
	}
	if !sourceController && !sourceUnknown {
		progress.UnknownTasks++
	}
	active, err := q.ListEngineeringProjectActiveTasks(ctx, db.ListEngineeringProjectActiveTasksParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID})
	if err != nil {
		return progress, err
	}
	if progress.UnknownTasks == 0 && progress.UnfinishedControllers == 0 && len(active) == 0 {
		canonical, e := filepath.EvalSymlinks(fence.WorkspacePath)
		info, statErr := os.Stat(fence.WorkspacePath)
		if e == nil && statErr == nil && info.IsDir() && canonical == fence.WorkspacePath {
			progress.Phase = "owned"
			progress.WorkspaceRoot = &fence.WorkspacePath
		}
	}
	if err = validate(); err != nil {
		return progress, err
	}
	if _, err = q.SetEngineeringRepairFenceState(ctx, db.SetEngineeringRepairFenceStateParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID, CaseID: fence.CaseID, AttemptID: fence.AttemptID, Generation: fence.Generation, OwnerID: fence.OwnerID, SupervisionToken: fence.SupervisionToken, Phase: progress.Phase, Targets: data}); err != nil {
		return progress, err
	}
	if err = tx.Commit(ctx); err != nil {
		return progress, err
	}
	if err = validate(); err != nil {
		return engineeringRepairProgress{}, err
	}
	return progress, nil
}
