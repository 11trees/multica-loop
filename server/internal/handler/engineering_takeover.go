package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Inspection never grants a workspace fence or permission to write repairs.
func (h *Handler) ReconcileEngineeringTakeovers(ctx context.Context, authority engineeringAdminAuthority) error {
	data, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "takeover-pending", "authority": authority})
	if err != nil {
		return err
	}
	var requests []struct {
		Claim           json.RawMessage `json:"claim"`
		CaseID          string          `json:"case_id"`
		WorkspaceID     string          `json:"workspace_id"`
		IssueID         string          `json:"issue_id"`
		ObservationID   string          `json:"observation_id"`
		SnapshotHash    string          `json:"snapshot_hash"`
		SourceAttemptID string          `json:"source_attempt_id"`
	}
	if err = json.Unmarshal(data, &requests); err != nil {
		return err
	}
	for _, request := range requests {
		workspace, err := util.ParseUUID(request.WorkspaceID)
		if err != nil {
			return err
		}
		issueID, err := util.ParseUUID(request.IssueID)
		if err != nil {
			return err
		}
		issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: workspace})
		if err != nil {
			return err
		}
		category, err := issuestatus.CategoryWithError(ctx, h.Queries, workspace, issue.Status)
		if err != nil {
			return err
		}
		if !issue.ProjectID.Valid || issue.TriageState.Valid || category == issuestatus.CategoryClosed || category == issuestatus.CategoryDone {
			return fmt.Errorf("repair source issue no longer admits takeover")
		}
		raw, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-source", "actor": map[string]string{"kind": "host", "workspaceId": request.WorkspaceID, "issueId": request.IssueID}, "payload": map[string]string{"case_id": request.CaseID, "observation_id": request.ObservationID, "snapshot_hash": request.SnapshotHash}})
		if err != nil {
			return err
		}
		var source struct {
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
		}
		if json.Unmarshal(raw, &source) != nil || source.WorkspaceID != request.WorkspaceID || source.IssueID != request.IssueID || source.CaseID != request.CaseID || source.ObservationID != request.ObservationID || source.SnapshotHash != request.SnapshotHash || source.AttemptID != request.SourceAttemptID {
			return fmt.Errorf("repair source identity changed")
		}
		taskText, claimText, ok := strings.Cut(source.AttemptID, ":")
		if !ok {
			return fmt.Errorf("repair source has no native claim")
		}
		taskID, err := util.ParseUUID(taskText)
		if err != nil {
			return err
		}
		micros, err := strconv.ParseInt(claimText, 10, 64)
		if err != nil {
			return err
		}
		task, err := h.Queries.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{ID: taskID, WorkspaceID: workspace})
		if err != nil {
			return err
		}
		if task.IssueID != issueID || uuidToString(task.AgentID) != source.AgentID || !task.RuntimeID.Valid || !task.DispatchedAt.Valid || task.DispatchedAt.Time.UnixMicro() != micros {
			return fmt.Errorf("repair source native dispatch claim changed")
		}
		agent, err := h.Queries.GetAgent(ctx, task.AgentID)
		if err != nil {
			return err
		}
		if agent.WorkspaceID != workspace || agent.RuntimeID != task.RuntimeID {
			return fmt.Errorf("repair source runtime changed")
		}
		mappings, err := h.engineeringExecutionResources(ctx, issue, agent)
		if err != nil {
			return err
		}
		path := mappings[0]["path"]
		if canonical, e := filepath.EvalSymlinks(path); e == nil {
			path = canonical
		}
		if !filepath.IsAbs(source.RegisteredPath) || !filepath.IsAbs(source.ExecutionPath) || filepath.Clean(path) != source.RegisteredPath || mappings[0]["mode"] != source.Mode || source.Mode == "in_place" && source.ExecutionPath != source.RegisteredPath {
			return fmt.Errorf("repair source project directory changed")
		}
		_, err = h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "takeover-inspected", "claim": request.Claim, "payload": map[string]any{"observation_id": source.ObservationID, "snapshot_hash": source.SnapshotHash, "source_attempt_id": source.AttemptID, "project_id": uuidToString(issue.ProjectID), "runtime_id": uuidToString(task.RuntimeID), "registered_repository_path": source.RegisteredPath, "execution_repository_path": source.ExecutionPath, "mode": source.Mode, "receipt_hash": source.ReceiptHash, "code_version": source.CodeVersion, "kernel_version": source.KernelVersion, "host_version": source.HostVersion}})
		if err != nil {
			return err
		}
		if h.EngineeringTakeoverControl != nil {
			progress, callErr := h.EngineeringTakeoverControl.Call(ctx, map[string]any{"claim": request.Claim})
			if callErr != nil {
				return callErr
			}
			if _, err = h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "takeover-progress", "claim": request.Claim, "payload": progress}); err != nil {
				return err
			}
			if err = h.recordEngineeringRepairWorkspaceVersion(ctx, request.Claim, request.WorkspaceID, request.IssueID, request.CaseID, request.ObservationID, request.SnapshotHash, progress); err != nil {
				return err
			}
		}
	}
	return nil
}

// Physical ownership and a content version are separate facts. Persist physical
// progress first so a missing or unsupported source never fabricates a version.
func (h *Handler) recordEngineeringRepairWorkspaceVersion(ctx context.Context, claim json.RawMessage, workspace, issue, caseID, observation, snapshot string, raw json.RawMessage) error {
	var initial engineeringRepairProgress
	if err := json.Unmarshal(raw, &initial); err != nil {
		return err
	}
	if initial.Phase != "owned" || initial.WorkspaceRoot == nil {
		return nil
	}
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-workspace-version", "actor": map[string]string{"kind": "host", "workspaceId": workspace, "issueId": issue}, "payload": map[string]string{"case_id": caseID, "observation_id": observation, "snapshot_hash": snapshot}})
	if err != nil {
		return err
	}
	var version struct {
		SourceAttemptID  string `json:"source_attempt_id"`
		SnapshotHash     string `json:"snapshot_hash"`
		WorkspaceRoot    string `json:"workspace_root"`
		WorkspaceVersion string `json:"workspace_version"`
	}
	if err = json.Unmarshal(data, &version); err != nil {
		return err
	}
	if version.SourceAttemptID != initial.SourceAttemptID || version.SnapshotHash != initial.SnapshotHash || version.WorkspaceRoot != *initial.WorkspaceRoot || version.WorkspaceVersion == "" {
		return fmt.Errorf("repair workspace version belongs to another source")
	}
	// Revalidate native source, ownership and the exact writer cohort after the
	// asynchronous filesystem read; the management write also checks live intent.
	raw, err = h.EngineeringTakeoverControl.Call(ctx, map[string]any{"claim": claim})
	if err != nil {
		return err
	}
	var current engineeringRepairProgress
	if err = json.Unmarshal(raw, &current); err != nil {
		return err
	}
	if current.Phase != "owned" || current.WorkspaceRoot == nil || *current.WorkspaceRoot != version.WorkspaceRoot || current.TargetsHash != initial.TargetsHash || current.SourceAttemptID != version.SourceAttemptID || current.SnapshotHash != version.SnapshotHash {
		return fmt.Errorf("repair ownership changed during workspace version read")
	}
	current.WorkspaceVersion = &version.WorkspaceVersion
	_, err = h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "takeover-progress", "claim": claim, "payload": current})
	return err
}
