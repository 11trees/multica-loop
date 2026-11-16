package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (h *Handler) StartEngineeringLocalControl(ctx context.Context) error {
	if h.EngineeringWorker == nil {
		return nil
	}
	return engineering.StartLocalControl(ctx, h.cfg.EngineeringDatabasePath+".control.sock", h.controlEngineeringRepair)
}

type engineeringTakeoverCurrent struct {
	IntentRevision int64 `json:"intent_revision"`
	Request        struct {
		CaseID          string `json:"case_id"`
		WorkspaceID     string `json:"workspace_id"`
		IssueID         string `json:"issue_id"`
		ObservationID   string `json:"observation_id"`
		SnapshotHash    string `json:"snapshot_hash"`
		SourceAttemptID string `json:"source_attempt_id"`
		Claim           struct {
			AttemptID  string                    `json:"attemptId"`
			Generation int64                     `json:"generation"`
			Authority  engineeringAdminAuthority `json:"authority"`
		} `json:"claim"`
		Inspection struct {
			ProjectID      string  `json:"project_id"`
			RuntimeID      string  `json:"runtime_id"`
			RegisteredPath string  `json:"registered_repository_path"`
			ExecutionPath  string  `json:"execution_repository_path"`
			Mode           string  `json:"mode"`
			ReceiptHash    string  `json:"receipt_hash"`
			CodeVersion    string  `json:"code_version"`
			KernelVersion  *string `json:"kernel_version"`
			HostVersion    *string `json:"host_version"`
		} `json:"inspection"`
	} `json:"request"`
}
type engineeringTakeoverSource struct {
	WorkspaceID    string  `json:"workspace_id"`
	IssueID        string  `json:"issue_id"`
	AgentID        string  `json:"agent_id"`
	AttemptID      string  `json:"attempt_id"`
	ObservationID  string  `json:"observation_id"`
	CaseID         string  `json:"case_id"`
	SnapshotHash   string  `json:"snapshot_hash"`
	RegisteredPath string  `json:"registered_repository_path"`
	ExecutionPath  string  `json:"execution_repository_path"`
	Mode           string  `json:"mode"`
	ReceiptHash    string  `json:"receipt_hash"`
	CodeVersion    string  `json:"code_version"`
	KernelVersion  *string `json:"kernel_version"`
	HostVersion    *string `json:"host_version"`
	Revision       int64   `json:"revision"`
	Sequence       int64   `json:"sequence"`
}

// Read authoritative protocol and native state, never caller-provided paths.
func (h *Handler) engineeringTakeoverSource(ctx context.Context, claim json.RawMessage) (db.CreateEngineeringRepairFenceParams, error) {
	var pin db.CreateEngineeringRepairFenceParams
	data, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "takeover-current", "claim": claim})
	if err != nil {
		return pin, err
	}
	var current engineeringTakeoverCurrent
	if err = json.Unmarshal(data, &current); err != nil {
		return pin, err
	}
	return h.engineeringSourceForCurrent(ctx, current)
}
func (h *Handler) engineeringSourceForCurrent(ctx context.Context, current engineeringTakeoverCurrent) (db.CreateEngineeringRepairFenceParams, error) {
	var pin db.CreateEngineeringRepairFenceParams
	request := current.Request
	workspace, err := util.ParseUUID(request.WorkspaceID)
	if err != nil {
		return pin, err
	}
	project, err := util.ParseUUID(request.Inspection.ProjectID)
	if err != nil {
		return pin, err
	}
	issueID, err := util.ParseUUID(request.IssueID)
	if err != nil {
		return pin, err
	}
	raw, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-source", "actor": map[string]string{"kind": "host", "workspaceId": request.WorkspaceID, "issueId": request.IssueID}, "payload": map[string]string{"case_id": request.CaseID, "observation_id": request.ObservationID, "snapshot_hash": request.SnapshotHash}})
	if err != nil {
		return pin, err
	}
	var source engineeringTakeoverSource
	equalVersion := func(a, b *string) bool { return a != nil && b != nil && *a != "" && *a == *b }
	if json.Unmarshal(raw, &source) != nil || source.WorkspaceID != request.WorkspaceID || source.IssueID != request.IssueID || source.CaseID != request.CaseID || source.ObservationID != request.ObservationID || source.SnapshotHash != request.SnapshotHash || source.AttemptID != request.SourceAttemptID || source.Revision < 1 || source.Sequence < 0 || source.ReceiptHash == "" || source.ReceiptHash != request.Inspection.ReceiptHash || source.RegisteredPath != request.Inspection.RegisteredPath || source.ExecutionPath != request.Inspection.ExecutionPath || source.Mode != request.Inspection.Mode || source.CodeVersion != request.Inspection.CodeVersion || !equalVersion(source.KernelVersion, request.Inspection.KernelVersion) || !equalVersion(source.HostVersion, request.Inspection.HostVersion) {
		return pin, fmt.Errorf("original repair checkpoint or source versions changed")
	}
	taskText, claimText, ok := strings.Cut(source.AttemptID, ":")
	if !ok {
		return pin, fmt.Errorf("source has no native claim")
	}
	taskID, err := util.ParseUUID(taskText)
	if err != nil {
		return pin, err
	}
	micros, err := strconv.ParseInt(claimText, 10, 64)
	if err != nil {
		return pin, err
	}
	task, err := h.Queries.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{ID: taskID, WorkspaceID: workspace})
	if err != nil {
		return pin, err
	}
	if task.IssueID != issueID || uuidToString(task.AgentID) != source.AgentID || !task.DispatchedAt.Valid || task.DispatchedAt.Time.UnixMicro() != micros || uuidToString(task.RuntimeID) != request.Inspection.RuntimeID {
		return pin, fmt.Errorf("source dispatch changed before takeover")
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: workspace})
	if err != nil {
		return pin, err
	}
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, workspace, issue.Status)
	if err != nil {
		return pin, err
	}
	if issue.ProjectID != project || issue.TriageState.Valid || category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed {
		return pin, fmt.Errorf("source issue no longer admits takeover")
	}
	agent, err := h.Queries.GetAgent(ctx, task.AgentID)
	if err != nil {
		return pin, err
	}
	if agent.RuntimeID != task.RuntimeID || agent.WorkspaceID != workspace {
		return pin, fmt.Errorf("source agent runtime changed")
	}
	mappings, err := h.engineeringExecutionResources(ctx, issue, agent)
	if err != nil {
		return pin, err
	}
	path := mappings[0]["path"]
	if canonical, e := filepath.EvalSymlinks(path); e == nil {
		path = canonical
	}
	if !filepath.IsAbs(source.RegisteredPath) || !filepath.IsAbs(source.ExecutionPath) || filepath.Clean(path) != source.RegisteredPath || mappings[0]["mode"] != source.Mode || source.Mode == "in_place" && source.ExecutionPath != source.RegisteredPath {
		return pin, fmt.Errorf("source project directory changed")
	}
	pin = db.CreateEngineeringRepairFenceParams{WorkspaceID: workspace, ProjectID: project, CaseID: request.CaseID, AttemptID: request.Claim.AttemptID, Generation: request.Claim.Generation, OwnerID: request.Claim.Authority.OwnerID, SupervisionToken: request.Claim.Authority.Token, IntentRevision: current.IntentRevision, ObservationID: source.ObservationID, IssueID: issueID, SourceAttemptID: source.AttemptID, SourceRevision: source.Revision, SnapshotHash: source.SnapshotHash, WorkspacePath: source.RegisteredPath}
	if pin.CaseID == "" || pin.AttemptID == "" || pin.OwnerID == "" || pin.Generation < 1 || pin.SupervisionToken < 1 || pin.IntentRevision < 1 {
		return pin, fmt.Errorf("incomplete management identity")
	}
	return pin, nil
}
func engineeringFenceMatches(f db.EngineeringRepairFence, p db.CreateEngineeringRepairFenceParams) bool {
	return f.WorkspaceID == p.WorkspaceID && f.ProjectID == p.ProjectID && f.CaseID == p.CaseID && f.AttemptID == p.AttemptID && f.Generation == p.Generation && f.OwnerID == p.OwnerID && f.SupervisionToken == p.SupervisionToken && f.IntentRevision == p.IntentRevision && f.ObservationID == p.ObservationID && f.IssueID == p.IssueID && f.SourceAttemptID == p.SourceAttemptID && f.SourceRevision == p.SourceRevision && f.SnapshotHash == p.SnapshotHash && f.WorkspacePath == p.WorkspacePath && (f.Phase == "draining" || f.Phase == "owned")
}
func (h *Handler) acquireEngineeringRepairFence(ctx context.Context, claim json.RawMessage) (db.EngineeringRepairFence, error) {
	initial, err := h.engineeringTakeoverSource(ctx, claim)
	if err != nil {
		return db.EngineeringRepairFence{}, err
	}
	if h.TxStarter == nil {
		return db.EngineeringRepairFence{}, fmt.Errorf("takeover transactions unavailable")
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return db.EngineeringRepairFence{}, err
	}
	defer tx.Rollback(ctx)
	queries := h.Queries.WithTx(tx)
	if _, err = queries.LockEngineeringProject(ctx, db.LockEngineeringProjectParams{WorkspaceID: initial.WorkspaceID, ProjectID: initial.ProjectID}); err != nil {
		return db.EngineeringRepairFence{}, err
	}
	fresh, err := h.engineeringTakeoverSource(ctx, claim)
	if err != nil {
		return db.EngineeringRepairFence{}, err
	}
	if fresh != initial {
		return db.EngineeringRepairFence{}, fmt.Errorf("repair source changed while acquiring project")
	}
	fence, err := queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: fresh.WorkspaceID, ProjectID: fresh.ProjectID})
	if errors.Is(err, pgx.ErrNoRows) {
		fence, err = queries.CreateEngineeringRepairFence(ctx, fresh)
	}
	if err != nil {
		return fence, err
	}
	if !engineeringFenceMatches(fence, fresh) && fence.CaseID == fresh.CaseID && fence.Generation < fresh.Generation {
		previous := fresh
		previous.AttemptID = fence.AttemptID
		previous.Generation = fence.Generation
		previous.OwnerID = fence.OwnerID
		previous.SupervisionToken = fence.SupervisionToken
		previous.IntentRevision = fence.IntentRevision
		if !engineeringFenceMatches(fence, previous) {
			return fence, fmt.Errorf("predecessor fence has another original source")
		}
		data, checkErr := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "takeover-predecessor", "claim": claim, "attempt_id": fence.AttemptID})
		if checkErr != nil {
			return fence, checkErr
		}
		var proof struct {
			Stopped bool `json:"stopped"`
		}
		if json.Unmarshal(data, &proof) != nil || !proof.Stopped {
			return fence, fmt.Errorf("previous management invocation has no confirmed physical exit")
		}
		again, checkErr := h.engineeringTakeoverSource(ctx, claim)
		if checkErr != nil {
			return fence, checkErr
		}
		if again != fresh {
			return fence, fmt.Errorf("successor authority changed")
		}
		fence, err = queries.ReplaceEngineeringRepairFenceOwner(ctx, db.ReplaceEngineeringRepairFenceOwnerParams{WorkspaceID: fresh.WorkspaceID, ProjectID: fresh.ProjectID, CaseID: fresh.CaseID, AttemptID: fresh.AttemptID, Generation: fresh.Generation, OwnerID: fresh.OwnerID, SupervisionToken: fresh.SupervisionToken, IntentRevision: fresh.IntentRevision})
		if err != nil {
			return fence, err
		}
	}
	if !engineeringFenceMatches(fence, fresh) {
		return fence, fmt.Errorf("project belongs to another repair owner or source version")
	}
	if err = tx.Commit(ctx); err != nil {
		return fence, err
	}
	return fence, nil
}

// Commit admission fencing before cancellation; retain the fence on later failure.
func (h *Handler) DrainEngineeringProject(ctx context.Context, body json.RawMessage) (any, error) {
	var input struct {
		Claim json.RawMessage `json:"claim"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return nil, err
	}
	fence, err := h.acquireEngineeringRepairFence(ctx, input.Claim)
	if err != nil {
		return nil, err
	}
	validate := func() error {
		fresh, err := h.engineeringTakeoverSource(ctx, input.Claim)
		if err != nil {
			return err
		}
		current, err := h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID})
		if err != nil {
			return err
		}
		if !engineeringFenceMatches(current, fresh) {
			return fmt.Errorf("repair fence or source authority changed")
		}
		return nil
	}
	if err = validate(); err != nil {
		return nil, err
	}
	targets, err := h.recordEngineeringRepairTargets(ctx, fence)
	if err != nil {
		return nil, err
	}
	if h.TaskService == nil {
		return nil, fmt.Errorf("native cancellation unavailable")
	}
	tasks, err := h.Queries.ListEngineeringProjectActiveTasks(ctx, db.ListEngineeringProjectActiveTasksParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID})
	if err != nil {
		return nil, err
	}
	cancelled := 0
	for _, task := range tasks {
		if err = validate(); err != nil {
			return nil, err
		}
		result, err := h.TaskService.CancelTaskWithReason(ctx, task.ID, "Workspace repair is draining the original execution", "intervention")
		if err != nil {
			return nil, err
		}
		if result != nil && result.Status == "cancelled" {
			cancelled++
		}
	}
	if err = validate(); err != nil {
		return nil, err
	}
	controllers, err := h.Queries.ListEngineeringProjectControllers(ctx, db.ListEngineeringProjectControllersParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID})
	if err != nil {
		return nil, err
	}
	for _, guard := range controllers {
		if err = h.reconcileEngineeringPhysicalController(ctx, guard, validate); err != nil {
			return nil, err
		}
	}
	return h.finishEngineeringPhysicalDrain(ctx, fence, targets, cancelled, validate)
}
