package handler

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/projectaccess"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Initial human authorization supplies every role; native state is checked again
// at each automatic boundary before the frozen policy is applied.
func (h *Handler) dispatchEndToEnd(ctx context.Context, item engineeringContinuation) error {
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
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, workspaceID, issue.Status)
	if err != nil {
		return err
	}
	if issue.TriageState.Valid || category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed {
		return nil
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(ctx, issue.ID)
	if err != nil || active {
		return err
	}
	idle, err := h.managedRunsIdle(ctx, issue)
	if err != nil || !idle {
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
		return fmt.Errorf("End to End project is no longer visible")
	}
	actor := map[string]string{"kind": "host", "workspaceId": item.WorkspaceID, "issueId": item.IssueID}
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": actor, "action": "end-to-end-scope"})
	if err != nil {
		return err
	}
	var scope struct {
		ProjectID string            `json:"project_id"`
		UserID    string            `json:"user_id"`
		Roles     map[string]string `json:"roles"`
		HandedOff bool              `json:"handed_off"`
	}
	if json.Unmarshal(data, &scope) != nil || !issue.ProjectID.Valid || scope.ProjectID != uuidToString(issue.ProjectID) || scope.UserID != item.UserID || len(scope.Roles) != 6 {
		return fmt.Errorf("End to End frozen native scope changed")
	}
	resources := []map[string]string{}
	var reviewerResources []map[string]string
	for _, key := range []string{"context", "planner", "analyst", "developer", "verifier", "reviewer"} {
		id, err := util.ParseUUID(scope.Roles[key])
		if err != nil {
			return err
		}
		agent, err := h.Queries.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: id, WorkspaceID: workspaceID})
		if err != nil {
			return err
		}
		if agent.ArchivedAt.Valid || !h.canInvokeAgent(ctx, agent, "member", item.UserID, item.UserID, item.WorkspaceID) {
			return fmt.Errorf("End to End role is no longer invocable")
		}
		mapping, err := h.engineeringExecutionResources(ctx, issue, agent)
		if err != nil {
			return err
		}
		resources = append(resources, mapping...)
		if key == "reviewer" {
			reviewerResources = mapping
		}
	}
	if _, err = h.EngineeringWorker.Call(ctx, map[string]any{"actor": actor, "action": "end-to-end-scope", "payload": map[string]any{"execution_resources": resources}}); err != nil {
		return err
	}
	if item.Reason == "business_handoff" {
		if item.AgentID != scope.Roles["context"] || item.ExpectedRevision != 1 {
			return fmt.Errorf("End to End handoff checkpoint changed")
		}
		data, err = h.EngineeringWorker.Call(ctx, map[string]any{"actor": actor, "action": "business-handoff", "payload": map[string]any{"expected_version": item.ExpectedSequence, "execution_resources": resources}})
		if err != nil {
			return err
		}
		var result struct {
			HandedOff bool `json:"handed_off"`
		}
		if json.Unmarshal(data, &result) != nil || !result.HandedOff {
			return fmt.Errorf("invalid End to End handoff result")
		}
		return nil
	}
	if !scope.HandedOff || item.AgentID != scope.Roles["reviewer"] {
		return fmt.Errorf("End to End delivery authority changed")
	}
	if item.Reason == "end_to_end_publish" {
		return h.publishEngineeringUnits(ctx, issue, item.UserID, item.ExpectedRevision, item.ExpectedSequence)
	}
	if item.Reason != "end_to_end_review" {
		return fmt.Errorf("invalid End to End continuation")
	}
	units, err := h.loadReviewUnits(ctx, issue, true)
	if err != nil {
		return err
	}
	ids := make([]string, len(units))
	for i, unit := range units {
		ids[i] = unit.IssueID
	}
	data, err = h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "human", "workspaceId": item.WorkspaceID, "issueId": item.IssueID, "userId": item.UserID}, "action": "configure-review", "payload": map[string]any{"expected_revision": item.ExpectedRevision, "expected_sequence": item.ExpectedSequence, "agent_id": scope.Roles["reviewer"], "execution_resources": reviewerResources, "native_unit_ids": ids}})
	if err != nil {
		return err
	}
	var result struct {
		Configured bool `json:"configured"`
	}
	if json.Unmarshal(data, &result) != nil || !result.Configured {
		return fmt.Errorf("invalid End to End review result")
	}
	return nil
}
