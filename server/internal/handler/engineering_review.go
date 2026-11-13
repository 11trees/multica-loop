package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/projectaccess"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type engineeringReviewUnit struct {
	IssueID        string `json:"issue_id"`
	ContractHash   string `json:"contract_hash"`
	PlanDraftID    string `json:"plan_draft_id"`
	ParentRevision int    `json:"parent_revision"`
	UnitKey        string `json:"unit_key"`
}

// Native lifecycle and ownership remain authoritative outside the protocol store.
func (h *Handler) reviewNativeUnits(ctx context.Context, parent db.Issue, units []engineeringReviewUnit, open bool) error {
	if len(units) == 0 || !parent.ProjectID.Valid || parent.TriageState.Valid {
		return &engineering.Rejection{Message: "requirement review has no accepted native delivery scope", Conflict: true}
	}
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, parent.WorkspaceID, parent.Status)
	if err != nil {
		return err
	}
	if category == issuestatus.CategoryClosed || open && category == issuestatus.CategoryDone {
		return &engineering.Rejection{Message: "requirement review is closed", Conflict: true}
	}
	seen := make(map[string]bool)
	for _, unit := range units {
		id, err := util.ParseUUID(unit.IssueID)
		if err != nil || seen[unit.IssueID] {
			return fmt.Errorf("invalid native review unit identity")
		}
		seen[unit.IssueID] = true
		child, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: id, WorkspaceID: parent.WorkspaceID})
		if err != nil {
			return err
		}
		category, err := issuestatus.CategoryWithError(ctx, h.Queries, parent.WorkspaceID, child.Status)
		if err != nil {
			return err
		}
		if child.ParentIssueID != parent.ID || child.ProjectID != parent.ProjectID || child.TriageState.Valid || category != issuestatus.CategoryDone {
			return &engineering.Rejection{Message: "requirement review needs every frozen child in native Done under the same parent and project", Conflict: true}
		}
		var metadata map[string]json.RawMessage
		var plan, key, hash string
		var revision int
		if json.Unmarshal(child.Metadata, &metadata) != nil || json.Unmarshal(metadata["engineering.plan"], &plan) != nil || json.Unmarshal(metadata["engineering.unit"], &key) != nil || json.Unmarshal(metadata["engineering.contract"], &hash) != nil || json.Unmarshal(metadata["engineering.revision"], &revision) != nil || plan != unit.PlanDraftID || key != unit.UnitKey || hash != unit.ContractHash || revision != unit.ParentRevision {
			return &engineering.Rejection{Message: "native review child origin differs from its frozen contract", Conflict: true}
		}
		active, err := h.Queries.HasUnfinishedEngineeringIssueTask(ctx, id)
		if err != nil {
			return err
		}
		if active {
			return &engineering.Rejection{Message: "a requirement child run is unfinished", Conflict: true}
		}
	}
	return nil
}

func (h *Handler) reviewNativeIdle(ctx context.Context, parent db.Issue, units []engineeringReviewUnit, open bool) error {
	if err := h.reviewNativeUnits(ctx, parent, units, open); err != nil {
		return err
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(ctx, parent.ID)
	if err != nil {
		return err
	}
	if active {
		return &engineering.Rejection{Message: "the requirement run is unfinished", Conflict: true}
	}
	return nil
}

func (h *Handler) loadReviewUnits(ctx context.Context, parent db.Issue, open bool) ([]engineeringReviewUnit, error) {
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "host", "workspaceId": uuidToString(parent.WorkspaceID), "issueId": uuidToString(parent.ID)}, "action": "review-inputs"})
	if err != nil {
		return nil, err
	}
	var scope struct {
		Units []engineeringReviewUnit `json:"review_units"`
	}
	if json.Unmarshal(data, &scope) != nil || len(scope.Units) == 0 {
		return nil, fmt.Errorf("invalid frozen requirement review scope")
	}
	if err := h.reviewNativeIdle(ctx, parent, scope.Units, open); err != nil {
		return nil, err
	}
	return scope.Units, nil
}

func (h *Handler) ConfigureEngineeringReview(w http.ResponseWriter, r *http.Request) {
	parent, userID, ok := h.loadHumanEngineeringIssue(w, r)
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering is not enabled")
		return
	}
	var payload struct {
		ExpectedRevision int    `json:"expected_revision"`
		ExpectedSequence int    `json:"expected_sequence"`
		AgentID          string `json:"agent_id"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil || payload.ExpectedRevision < 1 || payload.ExpectedSequence < 0 {
		writeError(w, http.StatusBadRequest, "invalid requirement review checkpoint")
		return
	}
	agent, ok := h.loadAgentForUser(w, r, payload.AgentID)
	if !ok {
		return
	}
	if !h.canInvokeAgent(r.Context(), agent, "member", userID, userID, uuidToString(parent.WorkspaceID)) {
		writeError(w, http.StatusForbidden, "reviewer is not invocable")
		return
	}
	units, err := h.loadReviewUnits(r.Context(), parent, true)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	mappings, err := h.engineeringExecutionResources(r.Context(), parent, agent)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	ids := make([]string, len(units))
	for i, unit := range units {
		ids[i] = unit.IssueID
	}
	result, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"actor": map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(parent.WorkspaceID), "issueId": uuidToString(parent.ID)}, "action": "configure-review", "payload": map[string]any{"expected_revision": payload.ExpectedRevision, "expected_sequence": payload.ExpectedSequence, "agent_id": uuidToString(agent.ID), "execution_resources": mappings, "native_unit_ids": ids}})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) AcknowledgeEngineeringReview(w http.ResponseWriter, r *http.Request) {
	parent, userID, ok := h.loadHumanEngineeringIssue(w, r)
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering is not enabled")
		return
	}
	var payload struct {
		ExpectedRevision int    `json:"expected_revision"`
		ExpectedSequence int    `json:"expected_sequence"`
		ReportHash       string `json:"report_hash"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil || payload.ExpectedRevision < 1 || payload.ExpectedSequence < 0 || len(payload.ReportHash) != 64 {
		writeError(w, http.StatusBadRequest, "invalid closure reading acknowledgement")
		return
	}
	if _, err := h.loadReviewUnits(r.Context(), parent, false); err != nil {
		engineeringControlError(w, err)
		return
	}
	_, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"actor": map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(parent.WorkspaceID), "issueId": uuidToString(parent.ID)}, "action": "review-ack", "payload": payload})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	category, err := issuestatus.CategoryWithError(r.Context(), h.Queries, parent.WorkspaceID, parent.Status)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	if category == issuestatus.CategoryDone {
		writeJSON(w, http.StatusOK, map[string]bool{"acknowledged": true})
		return
	}
	ctx := context.WithValue(r.Context(), wakeupActorKey{}, wakeupActor{kind: "member", id: userID})
	params := db.UpdateIssueParams{ID: parent.ID, Status: pgtype.Text{String: issuestatus.Done, Valid: true}}
	refreshUntouchedNullableIssueParams(&params, parent, nil, false)
	updated, err := h.updateIssueWithStatusGuard(ctx, parent.WorkspaceID, issuestatus.Done, params)
	if err != nil {
		if !writeEngineeringCompletionError(w, err) {
			writeError(w, http.StatusConflict, err.Error())
		}
		return
	}
	h.publishIssueSnapshots(ctx, []db.Issue{updated}, "member", userID)
	writeJSON(w, http.StatusOK, map[string]bool{"acknowledged": true})
}

func (h *Handler) dispatchRequirementReview(ctx context.Context, item engineeringContinuation) error {
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
	parent, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: workspaceID})
	if err != nil {
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
	if !access.CanSeeProject(parent.ProjectID) {
		return fmt.Errorf("review project is no longer visible")
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(ctx, parent.ID)
	if err != nil || active {
		return err
	}
	idle, err := h.managedRunsIdle(ctx, parent)
	if err != nil || !idle {
		return err
	}
	if item.Reason == "review_forward" || item.Reason == "feedback_forward" {
		return h.publishEngineeringUnits(ctx, parent, item.UserID, item.ExpectedRevision, item.ExpectedSequence)
	}
	units, err := h.loadReviewUnits(ctx, parent, true)
	if err != nil {
		return err
	}
	agentID, err := util.ParseUUID(item.AgentID)
	if err != nil {
		return err
	}
	agent, err := h.Queries.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: agentID, WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	if agent.ArchivedAt.Valid || !h.canInvokeAgent(ctx, agent, "member", item.UserID, item.UserID, item.WorkspaceID) {
		return fmt.Errorf("requirement reviewer is no longer invocable")
	}
	mappings, err := h.engineeringExecutionResources(ctx, parent, agent)
	if err != nil {
		return err
	}
	ids := make([]string, len(units))
	for i, unit := range units {
		ids[i] = unit.IssueID
	}
	actor := map[string]string{"kind": "human", "userId": item.UserID, "workspaceId": item.WorkspaceID, "issueId": item.IssueID}
	action := "configure-review"
	payload := map[string]any{"expected_revision": item.ExpectedRevision, "expected_sequence": item.ExpectedSequence, "agent_id": item.AgentID, "execution_resources": mappings, "native_unit_ids": ids}
	if item.Reason == "feedback_verify_next" {
		actor = map[string]string{"kind": "host", "workspaceId": item.WorkspaceID, "issueId": item.IssueID}
		action = "prepare-feedback-verification"
		payload = map[string]any{"batch_id": item.FeedbackBatchID, "group_id": item.FeedbackGroupID, "comment_id": item.FeedbackCommentID, "expected_version": item.ExpectedSequence, "agent_id": item.AgentID, "user_id": item.UserID, "execution_resources": mappings, "native_unit_ids": ids}
	}
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": actor, "action": action, "payload": payload})
	if err != nil {
		return err
	}
	var result struct {
		Configured *bool `json:"configured"`
	}
	if json.Unmarshal(data, &result) != nil || result.Configured == nil || !*result.Configured {
		return fmt.Errorf("invalid next review checkpoint")
	}
	return nil
}
