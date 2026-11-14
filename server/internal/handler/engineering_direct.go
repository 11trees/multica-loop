package handler

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/projectaccess"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const directRunInstruction = "Execute only the frozen Direct input. First run multica engineering direct-run. After completing the actual work, submit with multica engineering direct-submit --summary-file <task-temp-file> [--result-file <task-temp-file>]. Ordinary final text and process exit cannot submit a result."

type engineeringDirectScope struct {
	ProjectID  string `json:"project_id"`
	AgentID    string `json:"agent_id"`
	AttemptID  string `json:"attempt_id"`
	ResultHash string `json:"result_hash"`
}

func (h *Handler) ConfigureEngineeringDirect(w http.ResponseWriter, r *http.Request) {
	issue, userID, ok := h.loadHumanEngineeringIssue(w, r)
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering is not enabled")
		return
	}
	var input struct {
		ExpectedRevision int    `json:"expected_revision"`
		AgentID          string `json:"agent_id"`
		RepositoryPath   string `json:"repository_path"`
		Input            string `json:"input"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.ExpectedRevision != 0 || strings.TrimSpace(input.Input) == "" || strings.TrimSpace(input.RepositoryPath) == "" {
		writeError(w, http.StatusBadRequest, "invalid Direct configuration")
		return
	}
	category, err := issuestatus.CategoryWithError(r.Context(), h.Queries, issue.WorkspaceID, issue.Status)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(r.Context(), issue.ID)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	if active || !issue.ProjectID.Valid || issue.TriageState.Valid || category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed {
		writeError(w, http.StatusConflict, "Direct requires an idle open accepted project issue")
		return
	}
	agent, ok := h.loadAgentForUser(w, r, input.AgentID)
	if !ok {
		return
	}
	if !h.canInvokeAgent(r.Context(), agent, "member", userID, userID, uuidToString(issue.WorkspaceID)) {
		writeError(w, http.StatusForbidden, "Direct agent is not invocable")
		return
	}
	resources, err := h.engineeringExecutionResources(r.Context(), issue, agent)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	_, err = h.EngineeringWorker.Call(r.Context(), map[string]any{"actor": map[string]string{"kind": "human", "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID), "userId": userID}, "action": "configure-direct", "payload": map[string]any{"expected_revision": 0, "agent_id": uuidToString(agent.ID), "project_id": uuidToString(issue.ProjectID), "repository_path": input.RepositoryPath, "input": input.Input, "execution_resources": resources}})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"configured": true})
}

func (h *Handler) RunEngineeringDirect(w http.ResponseWriter, r *http.Request) {
	h.taskEngineering(w, r, "direct-run")
}
func (h *Handler) SubmitEngineeringDirect(w http.ResponseWriter, r *http.Request) {
	h.taskEngineering(w, r, "direct-submit")
}

func (h *Handler) directNativeScope(ctx context.Context, issue db.Issue, scope engineeringDirectScope) error {
	if !issue.ProjectID.Valid || scope.ProjectID != uuidToString(issue.ProjectID) || issue.TriageState.Valid {
		return fmt.Errorf("Direct original native project changed")
	}
	fingerprint, err := hex.DecodeString(scope.ResultHash)
	if err != nil || len(fingerprint) != 32 {
		return fmt.Errorf("invalid Direct result fingerprint")
	}
	id, claim, ok := strings.Cut(scope.AttemptID, ":")
	if !ok {
		return fmt.Errorf("invalid Direct native attempt")
	}
	taskID, err := util.ParseUUID(id)
	if err != nil {
		return err
	}
	micros, err := strconv.ParseInt(claim, 10, 64)
	if err != nil {
		return err
	}
	task, err := h.Queries.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{ID: taskID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return err
	}
	if task.IssueID != issue.ID || uuidToString(task.AgentID) != scope.AgentID || !task.DispatchedAt.Valid || task.DispatchedAt.Time.UnixMicro() != micros || !task.CompletedAt.Valid {
		return fmt.Errorf("Direct submitted native run is unfinished or changed")
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(ctx, issue.ID)
	if err != nil {
		return err
	}
	if active {
		return fmt.Errorf("wait for native Direct runs to finish")
	}
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, issue.WorkspaceID, issue.Status)
	if err != nil {
		return err
	}
	if category == issuestatus.CategoryClosed {
		return fmt.Errorf("reopen Direct before completing its submitted result")
	}
	return nil
}

func (h *Handler) dispatchDirect(ctx context.Context, item engineeringContinuation) error {
	workspaceID, err := util.ParseUUID(item.WorkspaceID)
	if err != nil {
		return err
	}
	issueID, err := util.ParseUUID(item.IssueID)
	if err != nil {
		return err
	}
	userID, err := util.ParseUUID(item.UserID)
	if err != nil {
		return err
	}
	agentID, err := util.ParseUUID(item.AgentID)
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
	if category == issuestatus.CategoryClosed {
		return nil
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(ctx, issue.ID)
	if err != nil || active {
		return err
	}
	member, err := h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: userID, WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	access, err := projectaccess.ForMember(ctx, h.Queries, workspaceID, userID, member.Role)
	if err != nil {
		return err
	}
	if !access.CanSeeProject(issue.ProjectID) {
		return fmt.Errorf("Direct project is no longer visible")
	}
	agent, err := h.Queries.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: agentID, WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	if agent.ArchivedAt.Valid || !h.canInvokeAgent(ctx, agent, "member", item.UserID, item.UserID, item.WorkspaceID) {
		return fmt.Errorf("Direct agent is no longer invocable")
	}
	actor := map[string]string{"kind": "host", "workspaceId": item.WorkspaceID, "issueId": item.IssueID}
	if item.Reason == "direct_ready" {
		if category == issuestatus.CategoryDone {
			return nil
		}
		taskID, err := util.ParseUUID(item.TaskID)
		if err != nil {
			return err
		}
		if existing, err := h.Queries.GetAgentTask(ctx, taskID); err == nil {
			if existing.IssueID != issueID || existing.AgentID != agentID || existing.OriginatorUserID != userID {
				return fmt.Errorf("Direct continuation identity changed")
			}
			return nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		resources, err := h.engineeringExecutionResources(ctx, issue, agent)
		if err != nil {
			return err
		}
		data, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "human", "workspaceId": item.WorkspaceID, "issueId": item.IssueID, "userId": item.UserID}, "action": "prepare-run", "payload": map[string]any{"expected_revision": item.ExpectedRevision, "expected_sequence": item.ExpectedSequence, "execution_resources": resources}})
		if err != nil {
			return err
		}
		var selected struct {
			AgentID string `json:"agent_id"`
			Chain   string `json:"chain"`
		}
		if json.Unmarshal(data, &selected) != nil || selected.AgentID != item.AgentID || selected.Chain != "direct" {
			return fmt.Errorf("Direct continuation role changed")
		}
		if err := requireEngineeringProject(issue, data); err != nil {
			return err
		}
		_, err = h.TaskService.EnqueueEngineeringContinuation(ctx, issue, agentID, userID, taskID, directRunInstruction)
		return err
	}
	if item.Reason != "direct_submitted" {
		return fmt.Errorf("invalid Direct continuation")
	}
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": actor, "action": "direct-scope"})
	if err != nil {
		return err
	}
	var result struct {
		Scope *engineeringDirectScope `json:"direct_scope"`
	}
	if json.Unmarshal(data, &result) != nil || result.Scope == nil || result.Scope.AgentID != item.AgentID {
		return fmt.Errorf("invalid Direct submitted result scope")
	}
	if err = h.directNativeScope(ctx, issue, *result.Scope); err != nil {
		return err
	}
	if category != issuestatus.CategoryDone {
		writeCtx := context.WithValue(ctx, wakeupActorKey{}, wakeupActor{kind: "member", id: item.UserID})
		params := db.UpdateIssueParams{ID: issue.ID, Status: pgtype.Text{String: issuestatus.Done, Valid: true}}
		refreshUntouchedNullableIssueParams(&params, issue, nil, false)
		updated, err := h.updateIssueWithStatusGuard(writeCtx, issue.WorkspaceID, issuestatus.Done, params)
		if err != nil {
			return err
		}
		h.publishIssueSnapshots(writeCtx, []db.Issue{updated}, "member", item.UserID)
	}
	data, err = h.EngineeringWorker.Call(ctx, map[string]any{"actor": actor, "action": "direct-completed", "payload": map[string]string{"result_hash": result.Scope.ResultHash}})
	if err != nil {
		return err
	}
	var ack struct {
		Acknowledged bool `json:"acknowledged"`
	}
	if json.Unmarshal(data, &ack) != nil || !ack.Acknowledged {
		return fmt.Errorf("invalid native Direct acknowledgement")
	}
	return nil
}
