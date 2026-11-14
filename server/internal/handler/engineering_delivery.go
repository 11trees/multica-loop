package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/projectaccess"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (h *Handler) managedParent(ctx context.Context, issue db.Issue, parentID string) (db.Issue, error) {
	id, err := util.ParseUUID(parentID)
	if err != nil || issue.ParentIssueID != id {
		return db.Issue{}, fmt.Errorf("managed issue parent changed")
	}
	parent, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: id, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return parent, err
	}
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, parent.WorkspaceID, parent.Status)
	if err != nil {
		return parent, err
	}
	if parent.TriageState.Valid || category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed || parent.ProjectID != issue.ProjectID {
		return parent, fmt.Errorf("managed requirement is closed, unaccepted, or moved to another project")
	}
	return parent, nil
}

func (h *Handler) managedRunScope(ctx context.Context, issue db.Issue) ([]string, error) {
	if h.EngineeringWorker == nil {
		return nil, nil
	}
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "host", "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID)}, "action": "parent-scope"})
	if err != nil {
		return nil, err
	}
	if err := requireEngineeringProject(issue, data); err != nil {
		return nil, err
	}
	var scope struct {
		Managed     *bool                    `json:"managed"`
		ReviewUnits *[]engineeringReviewUnit `json:"review_units"`
		ParentID    string                   `json:"parent_issue_id"`
		UnitIDs     []string                 `json:"unit_issue_ids"`
	}
	if json.Unmarshal(data, &scope) != nil || scope.Managed == nil {
		return nil, fmt.Errorf("invalid managed execution scope")
	}
	if scope.ReviewUnits != nil {
		if err := h.reviewNativeUnits(ctx, issue, *scope.ReviewUnits, true); err != nil {
			return nil, err
		}
		ids := make([]string, len(*scope.ReviewUnits))
		for i, unit := range *scope.ReviewUnits {
			ids[i] = unit.IssueID
		}
		return ids, nil
	}
	if !*scope.Managed {
		return nil, nil
	}
	if _, err := h.managedParent(ctx, issue, scope.ParentID); err != nil {
		return nil, err
	}
	return append(scope.UnitIDs, scope.ParentID), nil
}

func (h *Handler) managedRunsIdle(ctx context.Context, issue db.Issue) (bool, error) {
	ids, err := h.managedRunScope(ctx, issue)
	if err != nil {
		return false, err
	}
	for _, value := range ids {
		if value == uuidToString(issue.ID) {
			continue
		}
		id, err := util.ParseUUID(value)
		if err != nil {
			return false, err
		}
		active, err := h.Queries.HasUnfinishedEngineeringIssueTask(ctx, id)
		if err != nil {
			return false, err
		}
		if active {
			return false, nil
		}
	}
	return true, nil
}

func (h *Handler) AuthorizeEngineeringDelivery(w http.ResponseWriter, r *http.Request) {
	parent, userID, ok := h.loadHumanEngineeringIssue(w, r)
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering is not enabled")
		return
	}
	category, err := issuestatus.CategoryWithError(r.Context(), h.Queries, parent.WorkspaceID, parent.Status)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(r.Context(), parent.ID)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	if active || parent.TriageState.Valid || category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed {
		writeError(w, http.StatusConflict, "finish active runs and reopen the accepted requirement before delivery")
		return
	}
	var payload struct {
		ExpectedRevision int    `json:"expected_revision"`
		ExpectedSequence int    `json:"expected_sequence"`
		Analyst          string `json:"analyst_agent_id"`
		Developer        string `json:"developer_agent_id"`
		Verifier         string `json:"agent_id"`
		MaxReworks       int    `json:"max_reworks"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil || payload.ExpectedRevision < 1 || payload.ExpectedSequence < 0 || payload.MaxReworks < 0 || payload.MaxReworks > 10 {
		writeError(w, http.StatusBadRequest, "invalid managed delivery policy")
		return
	}
	resources := []map[string]string{}
	for _, id := range []string{payload.Analyst, payload.Developer, payload.Verifier} {
		agent, ok := h.loadAgentForUser(w, r, id)
		if !ok {
			return
		}
		if !h.canInvokeAgent(r.Context(), agent, "member", userID, userID, uuidToString(parent.WorkspaceID)) {
			writeError(w, http.StatusForbidden, "delivery agent is not invocable")
			return
		}
		mappings, err := h.engineeringExecutionResources(r.Context(), parent, agent)
		if err != nil {
			engineeringControlError(w, err)
			return
		}
		resources = append(resources, mappings...)
	}
	result, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"actor": map[string]string{"kind": "human", "workspaceId": uuidToString(parent.WorkspaceID), "issueId": uuidToString(parent.ID), "userId": userID}, "action": "delivery-policy", "payload": map[string]any{"expected_revision": payload.ExpectedRevision, "expected_sequence": payload.ExpectedSequence, "analyst_agent_id": payload.Analyst, "developer_agent_id": payload.Developer, "agent_id": payload.Verifier, "max_reworks": payload.MaxReworks, "execution_resources": resources}})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) dispatchManagedUnit(ctx context.Context, item engineeringContinuation) error {
	workspaceID, err := util.ParseUUID(item.WorkspaceID)
	if err != nil {
		return err
	}
	issueID, err := util.ParseUUID(item.IssueID)
	if err != nil {
		return err
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	if _, err := h.managedParent(ctx, issue, item.ParentIssueID); err != nil {
		return err
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(ctx, issueID)
	if err != nil || active {
		return err
	}
	idle, err := h.managedRunsIdle(ctx, issue)
	if err != nil || !idle {
		return err
	}
	userID, err := util.ParseUUID(item.UserID)
	if err != nil {
		return err
	}
	member, err := h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: userID, WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	hidden, err := projectaccess.ForMember(ctx, h.Queries, workspaceID, userID, member.Role)
	if err != nil {
		return err
	}
	if !hidden.CanSeeProject(issue.ProjectID) {
		return fmt.Errorf("managed project is no longer visible")
	}
	if item.Reason == "unit_activation" {
		category, err := issuestatus.CategoryWithError(ctx, h.Queries, workspaceID, issue.Status)
		if err != nil {
			return err
		}
		if issue.TriageState.Valid || category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed {
			return fmt.Errorf("managed unit is not open for activation")
		}
		agentID, err := util.ParseUUID(item.AgentID)
		if err != nil {
			return err
		}
		agent, err := h.Queries.GetAgent(ctx, agentID)
		if err != nil {
			return err
		}
		if agent.WorkspaceID != workspaceID || agent.ArchivedAt.Valid || !h.canInvokeAgent(ctx, agent, "member", item.UserID, item.UserID, item.WorkspaceID) {
			return fmt.Errorf("managed analyst is not invocable")
		}
		mappings, err := h.engineeringExecutionResources(ctx, issue, agent)
		if err != nil {
			return err
		}
		if len(mappings) != 1 {
			return fmt.Errorf("managed activation requires one project repository")
		}
		data, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "host", "workspaceId": item.WorkspaceID, "issueId": item.IssueID}, "action": "activate-unit", "payload": map[string]any{"expected_revision": item.ExpectedRevision, "expected_sequence": item.ExpectedSequence, "execution_mode": mappings[0]["mode"]}})
		if err != nil {
			return err
		}
		var next engineeringContinuation
		if json.Unmarshal(data, &next) != nil || next.IssueID != item.IssueID || next.ParentIssueID != item.ParentIssueID || next.UserID != item.UserID {
			return fmt.Errorf("invalid managed activation result")
		}
		return h.dispatchEngineeringContinuation(ctx, next)
	}
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, workspaceID, issue.Status)
	if err != nil {
		return err
	}
	if category == issuestatus.CategoryClosed || issue.TriageState.Valid {
		return fmt.Errorf("managed unit is closed or unaccepted")
	}
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "host", "workspaceId": item.WorkspaceID, "issueId": item.IssueID}, "action": "completion"})
	if err != nil {
		return err
	}
	var conclusion struct {
		Allowed *bool           `json:"allowed"`
		Binding json.RawMessage `json:"binding"`
	}
	if json.Unmarshal(data, &conclusion) != nil || conclusion.Allowed == nil || !*conclusion.Allowed || len(conclusion.Binding) == 0 {
		return fmt.Errorf("managed verification is unavailable")
	}
	if category != issuestatus.CategoryDone {
		ctx = context.WithValue(ctx, wakeupActorKey{}, wakeupActor{kind: "member", id: item.UserID})
		params := db.UpdateIssueParams{ID: issue.ID, Status: pgtype.Text{String: issuestatus.Done, Valid: true}}
		refreshUntouchedNullableIssueParams(&params, issue, nil, false)
		updated, err := h.updateIssueWithStatusGuard(ctx, workspaceID, issuestatus.Done, params)
		if err != nil {
			return err
		}
		h.publishIssueSnapshots(ctx, []db.Issue{updated}, "member", item.UserID)
	}
	_, err = h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "host", "workspaceId": item.WorkspaceID, "issueId": item.IssueID}, "action": "accept-unit", "payload": map[string]any{"binding": conclusion.Binding}})
	return err
}
