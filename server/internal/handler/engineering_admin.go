package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func engineeringHostVersion() string {
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return ""
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil))
}

type engineeringAdminAuthority struct {
	OwnerID string `json:"ownerId"`
	Token   int64  `json:"token"`
}
type engineeringRepairObservation struct {
	DispatchStall *engineeringDispatchStall `json:"dispatchStall"`
	Recovery      *engineeringRecoveryFault `json:"recovery"`
	WorkspaceID   string                    `json:"workspaceId"`
	IssueID       string                    `json:"issueId"`
	AgentID       string                    `json:"agentId"`
	AttemptID     string                    `json:"attemptId"`
	Chain         string                    `json:"chain"`
	ObservationID string                    `json:"observationId"`
	Summary       string                    `json:"summary"`
	SnapshotHash  string                    `json:"snapshotHash"`
	RequestHash   string                    `json:"requestHash"`
	KernelVersion string                    `json:"kernelVersion"`
	HostVersion   string                    `json:"hostVersion"`
}

// Supervision renewal does not wait behind business discovery or its worker mutex.
// Provider execution is supplied only by the independent management host.
func (h *Handler) RunEngineeringAdmin(ctx context.Context) {
	h.runEngineeringAdmin(ctx, 10*time.Second)
}

func (h *Handler) runEngineeringAdmin(ctx context.Context, interval time.Duration) {
	if h.EngineeringWorker == nil || h.EngineeringAdminWorker == nil {
		return
	}
	owner := "admin-host:" + randomID()
	var mu sync.RWMutex
	var authority *engineeringAdminAuthority
	renew := func() {
		mu.RLock()
		current := authority
		mu.RUnlock()
		if current != nil {
			data, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "renew", "authority": current})
			var result struct {
				Renewed bool `json:"renewed"`
			}
			if err == nil && json.Unmarshal(data, &result) == nil && result.Renewed {
				return
			}
		}
		data, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "acquire", "owner_id": owner, "execution_supported": h.EngineeringAdminExecutor != nil})
		var result struct {
			Authority *engineeringAdminAuthority `json:"authority"`
		}
		mu.Lock()
		defer mu.Unlock()
		authority = nil
		if err == nil && json.Unmarshal(data, &result) == nil && result.Authority != nil && result.Authority.OwnerID == owner && result.Authority.Token > 0 {
			authority = result.Authority
		}
	}
	renew()
	executionDone := make(chan struct{})
	go func() {
		defer close(executionDone)
		if h.EngineeringAdminExecutor == nil {
			return
		}
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			mu.RLock()
			current := authority
			mu.RUnlock()
			if current != nil {
				if err := h.EngineeringAdminExecutor.Tick(ctx, current.OwnerID, current.Token); err != nil && ctx.Err() == nil {
					slog.WarnContext(ctx, "engineering Admin execution waiting", "error", err)
				}
			} else {
				stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				h.EngineeringAdminExecutor.Stop(stop)
				cancel()
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	discoveryDone := make(chan struct{})
	go func() {
		defer close(discoveryDone)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			mu.RLock()
			current := authority
			mu.RUnlock()
			if current != nil {
				if err := h.ReconcileEngineeringAdmin(ctx, *current); err != nil && ctx.Err() == nil {
					slog.WarnContext(ctx, "engineering Admin observation waiting", "error", err)
				}
				if err := h.ReconcileEngineeringTakeovers(ctx, *current); err != nil && ctx.Err() == nil {
					slog.WarnContext(ctx, "engineering Admin takeover inspection waiting", "error", err)
				}
				if err := h.ReconcileEngineeringRepairHandoffs(ctx, *current); err != nil && ctx.Err() == nil {
					slog.WarnContext(ctx, "engineering Admin verified handoff preparation waiting", "error", err)
				}
				if err := h.ReconcileEngineeringRecoveryReadiness(ctx, *current); err != nil && ctx.Err() == nil {
					slog.WarnContext(ctx, "engineering Admin dispatch observation waiting", "error", err)
				}
				if err := h.ReconcileEngineeringRecoveryProgress(ctx, *current); err != nil && ctx.Err() == nil {
					slog.WarnContext(ctx, "engineering Admin recovery observation waiting", "error", err)
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	defer func() {
		mu.RLock()
		current := authority
		mu.RUnlock()
		select {
		case <-executionDone:
		case <-time.After(5 * time.Second):
		}
		confirmed := true
		if h.EngineeringAdminExecutor != nil {
			stop, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			confirmed = h.EngineeringAdminExecutor.Stop(stop)
			cancel()
		}
		if current != nil && confirmed {
			release, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = h.EngineeringAdminWorker.Call(release, map[string]any{"action": "release", "authority": current})
		}
		select {
		case <-discoveryDone:
		case <-time.After(5 * time.Second):
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			renew()
		}
	}
}

func (h *Handler) ReconcileEngineeringAdmin(ctx context.Context, authority engineeringAdminAuthority) error {
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-observations", "actor": map[string]string{"kind": "coordinator"}})
	if err != nil {
		return err
	}
	var records []json.RawMessage
	if err = json.Unmarshal(data, &records); err != nil {
		return fmt.Errorf("invalid pending repair observations")
	}
	var failures []error
	for _, raw := range records {
		if err = h.deliverEngineeringRepairObservation(ctx, authority, raw); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
func (h *Handler) deliverEngineeringRepairObservation(ctx context.Context, authority engineeringAdminAuthority, raw json.RawMessage) error {
	var observation engineeringRepairObservation
	if json.Unmarshal(raw, &observation) != nil || observation.Chain == "" || observation.ObservationID == "" || observation.Summary == "" {
		return fmt.Errorf("invalid original repair observation")
	}
	for _, value := range []string{observation.SnapshotHash, observation.RequestHash, strings.TrimPrefix(observation.KernelVersion, "sha256:"), strings.TrimPrefix(observation.HostVersion, "sha256:")} {
		decoded, err := hex.DecodeString(value)
		if err != nil || len(decoded) != 32 {
			return fmt.Errorf("repair observation requires its original checkpoint and kernel version")
		}
	}
	if !strings.HasPrefix(observation.KernelVersion, "sha256:") || !strings.HasPrefix(observation.HostVersion, "sha256:") {
		return fmt.Errorf("repair observation has no captured kernel version")
	}
	workspaceID, err := util.ParseUUID(observation.WorkspaceID)
	if err != nil {
		return err
	}
	issueID, err := util.ParseUUID(observation.IssueID)
	if err != nil {
		return err
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, workspaceID, issue.Status)
	if err != nil {
		return err
	}
	if category == issuestatus.CategoryClosed || category == issuestatus.CategoryDone {
		return nil
	}
	task, claim, ok := strings.Cut(observation.AttemptID, ":")
	if !ok {
		return fmt.Errorf("repair observation has no native source claim")
	}
	if _, err = strconv.ParseInt(claim, 10, 64); err != nil {
		return err
	}
	taskID, err := util.ParseUUID(task)
	if err != nil {
		return err
	}
	source, err := h.Queries.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{ID: taskID, WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	if source.IssueID != issueID || uuidToString(source.AgentID) != observation.AgentID {
		return fmt.Errorf("repair observation native source changed")
	}
	if observation.Recovery != nil {
		if err = h.validateEngineeringRecoveryFaultSource(ctx, observation, source, issue); err != nil {
			return err
		}
	}
	if observation.DispatchStall != nil {
		proof := observation.DispatchStall
		if observation.Recovery != nil || engineeringDispatchAnchor(*proof) != observation.AttemptID || proof.AgentID != observation.AgentID || proof.WorkspaceID != observation.WorkspaceID || proof.IssueID != observation.IssueID {
			return fmt.Errorf("stalled observation changed its retained anchor")
		}
		id, e := util.ParseUUID(proof.TaskID)
		if e != nil {
			return e
		}
		native, e := h.Queries.GetAgentTask(ctx, id)
		if e != nil {
			return e
		}
		if e = h.validateEngineeringDispatchStall(ctx, *proof, native); e != nil {
			return e
		}
	}
	scopeKey := observation.WorkspaceID + ":" + observation.IssueID + ":" + observation.Chain
	event := map[string]any{
		"observationId": observation.ObservationID, "workspaceId": observation.WorkspaceID, "issueId": observation.IssueID, "scope": "work-item", "scopeKey": scopeKey,
		"fingerprint": observation.RequestHash, "sourceVersion": "kernel:" + observation.KernelVersion + ";api:" + observation.HostVersion, "summary": observation.Summary, "origin": "business", "evidence": map[string]any{"original": raw},
	}
	if observation.Recovery != nil {
		event["repairCaseId"] = observation.Recovery.CaseID
	}
	if observation.DispatchStall != nil {
		event["repairCaseId"] = observation.DispatchStall.CaseID
	}
	result, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "observe", "authority": authority, "observation": event})
	if err != nil {
		return err
	}
	var repairCase struct {
		CaseID      string `json:"caseId"`
		WorkspaceID string `json:"workspaceId"`
		ScopeKey    string `json:"scopeKey"`
	}
	if json.Unmarshal(result, &repairCase) != nil || repairCase.CaseID == "" || repairCase.WorkspaceID != observation.WorkspaceID || repairCase.ScopeKey != scopeKey {
		return fmt.Errorf("invalid Admin observation receipt")
	}
	ack, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-observation-ack", "actor": map[string]string{"kind": "host", "workspaceId": observation.WorkspaceID, "issueId": observation.IssueID}, "payload": map[string]string{"observation_id": observation.ObservationID, "case_id": repairCase.CaseID, "snapshot_hash": observation.SnapshotHash}})
	if err != nil {
		return err
	}
	var receipt struct {
		Acknowledged bool `json:"acknowledged"`
	}
	if json.Unmarshal(ack, &receipt) != nil || !receipt.Acknowledged {
		return fmt.Errorf("Admin observation delivery was not acknowledged")
	}
	return nil
}

func (h *Handler) observeEngineeringDaemonCapacity(runtimes map[string]db.AgentRuntime, slots int) {
	if h.EngineeringWorker == nil || h.TaskService == nil || h.TaskService.EngineeringCapacity == nil {
		return
	}
	rows := make([]db.AgentRuntime, 0, len(runtimes))
	for _, runtime := range runtimes {
		rows = append(rows, runtime)
	}
	h.TaskService.EngineeringCapacity.Observe(rows, slots, time.Now())
}
