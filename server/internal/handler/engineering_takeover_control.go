package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (h *Handler) StartEngineeringLocalControl(ctx context.Context) error {
	if h.EngineeringWorker == nil {
		return nil
	}
	return engineering.StartLocalControl(ctx, h.cfg.EngineeringDatabasePath+".control.sock", h.DrainEngineeringProject)
}

var errEngineeringFenceRequired = errors.New("engineering repair fence required")

// The project fence must already be committed before invoking native cancellation.
func (h *Handler) DrainEngineeringProject(ctx context.Context, body json.RawMessage) (any, error) {
	var input struct {
		Claim json.RawMessage `json:"claim"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return nil, err
	}
	validate := func() (db.EngineeringRepairFence, error) {
		data, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "takeover-current", "claim": input.Claim})
		if err != nil {
			return db.EngineeringRepairFence{}, err
		}
		var current struct {
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
					ProjectID      string `json:"project_id"`
					RuntimeID      string `json:"runtime_id"`
					RegisteredPath string `json:"registered_repository_path"`
				} `json:"inspection"`
			} `json:"request"`
		}
		if err = json.Unmarshal(data, &current); err != nil {
			return db.EngineeringRepairFence{}, err
		}
		request := current.Request
		workspace, err := util.ParseUUID(request.WorkspaceID)
		if err != nil {
			return db.EngineeringRepairFence{}, err
		}
		project, err := util.ParseUUID(request.Inspection.ProjectID)
		if err != nil {
			return db.EngineeringRepairFence{}, err
		}
		fence, err := h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: workspace, ProjectID: project})
		if errors.Is(err, pgx.ErrNoRows) {
			return fence, errEngineeringFenceRequired
		}
		if err != nil {
			return fence, err
		}
		if fence.CaseID != request.CaseID || fence.AttemptID != request.Claim.AttemptID || fence.Generation != request.Claim.Generation || fence.OwnerID != request.Claim.Authority.OwnerID || fence.SupervisionToken != request.Claim.Authority.Token || fence.IntentRevision != current.IntentRevision || fence.ObservationID != request.ObservationID || fence.SnapshotHash != request.SnapshotHash || fence.SourceAttemptID != request.SourceAttemptID || uuidToString(fence.IssueID) != request.IssueID || fence.WorkspacePath != request.Inspection.RegisteredPath || fence.Phase != "draining" {
			return fence, fmt.Errorf("repair fence no longer belongs to this management invocation")
		}
		taskText, claimText, ok := strings.Cut(request.SourceAttemptID, ":")
		if !ok {
			return fence, fmt.Errorf("source has no claim")
		}
		taskID, err := util.ParseUUID(taskText)
		if err != nil {
			return fence, err
		}
		micros, err := strconv.ParseInt(claimText, 10, 64)
		if err != nil {
			return fence, err
		}
		task, err := h.Queries.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{ID: taskID, WorkspaceID: workspace})
		if err != nil {
			return fence, err
		}
		if task.IssueID != fence.IssueID || !task.DispatchedAt.Valid || task.DispatchedAt.Time.UnixMicro() != micros || uuidToString(task.RuntimeID) != request.Inspection.RuntimeID {
			return fence, fmt.Errorf("source dispatch changed before drain")
		}
		issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: fence.IssueID, WorkspaceID: workspace})
		if err != nil {
			return fence, err
		}
		if issue.ProjectID != project {
			return fence, fmt.Errorf("source project changed")
		}
		agent, err := h.Queries.GetAgent(ctx, task.AgentID)
		if err != nil {
			return fence, err
		}
		if agent.RuntimeID != task.RuntimeID {
			return fence, fmt.Errorf("source agent runtime changed")
		}
		_, err = h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-source", "actor": map[string]string{"kind": "host", "workspaceId": request.WorkspaceID, "issueId": request.IssueID}, "payload": map[string]string{"case_id": request.CaseID, "observation_id": request.ObservationID, "snapshot_hash": request.SnapshotHash}})
		return fence, err
	}
	fence, err := validate()
	if errors.Is(err, errEngineeringFenceRequired) {
		return map[string]any{"fence_required": true}, nil
	}
	if err != nil {
		return nil, err
	}
	if h.TaskService == nil {
		return nil, fmt.Errorf("native cancellation is unavailable")
	}
	tasks, err := h.Queries.ListEngineeringProjectActiveTasks(ctx, db.ListEngineeringProjectActiveTasksParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID})
	if err != nil {
		return nil, err
	}
	cancelled := 0
	for _, task := range tasks {
		if _, err = validate(); err != nil {
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
	if _, err = validate(); err != nil {
		return nil, err
	}
	controllers, err := h.Queries.ListEngineeringProjectControllers(ctx, db.ListEngineeringProjectControllersParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID})
	if err != nil {
		return nil, err
	}
	unfinished := 0
	for _, controller := range controllers {
		if controller.Phase != "quiesced" {
			unfinished++
		}
	}
	return map[string]any{"cancelled": cancelled, "unfinished_controllers": unfinished, "phase": "draining"}, nil
}
