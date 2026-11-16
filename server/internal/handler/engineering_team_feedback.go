package handler

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/projectaccess"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type engineeringTeamFeedbackScope struct {
	engineeringTeamFeedback
	UserID            string `json:"user_id"`
	NeedsReproduction bool   `json:"needs_reproduction"`
	Revision          int    `json:"revision"`
	Version           int    `json:"version"`
}

func (h *Handler) teamFeedbackWorkScope(ctx context.Context, issue db.Issue, batchID string, version int) (engineeringTeamFeedbackScope, error) {
	var scope engineeringTeamFeedbackScope
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "host", "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID)}, "action": "team-feedback-scope", "payload": map[string]any{"batch_id": batchID, "expected_version": version}})
	if err != nil {
		return scope, err
	}
	if json.Unmarshal(data, &scope) != nil || scope.Revision < 1 || scope.Version < 0 {
		return scope, fmt.Errorf("invalid Team Feedback work scope")
	}
	return scope, nil
}

func (h *Handler) authorizeEngineeringTeamFeedbackWork(ctx context.Context, issue db.Issue, user, batchID string, version int) (json.RawMessage, error) {
	reject := func(message string) error { return &engineering.Rejection{Message: message, Conflict: true} }
	policy, err := h.frozenEngineeringTeamFeedback(ctx, issue, user)
	if err != nil {
		return nil, err
	}
	if policy == nil {
		return nil, reject("Team Feedback policy is unavailable")
	}
	userID, err := util.ParseUUID(user)
	if err != nil {
		return nil, err
	}
	member, err := h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: userID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return nil, err
	}
	access, err := projectaccess.ForMember(ctx, h.Queries, issue.WorkspaceID, userID, member.Role)
	if err != nil {
		return nil, err
	}
	if !access.CanSeeProject(issue.ProjectID) {
		return nil, reject("Feedback project is no longer accessible")
	}
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, issue.WorkspaceID, issue.Status)
	if err != nil {
		return nil, err
	}
	if issue.TriageState.Valid || category == issuestatus.CategoryClosed {
		return nil, reject("Reopen and accept this requirement before Feedback work")
	}
	scope, err := h.teamFeedbackWorkScope(ctx, issue, batchID, version)
	if err != nil {
		return nil, err
	}
	if scope.UserID != user || scope.engineeringTeamFeedback != *policy {
		return nil, reject("Team Feedback authority changed")
	}
	roleIDs := []string{policy.Planner}
	if scope.NeedsReproduction {
		roleIDs = append(roleIDs, policy.Reproducer)
	}
	resources := []map[string]string{}
	for _, id := range roleIDs {
		roleID, err := util.ParseUUID(id)
		if err != nil {
			return nil, err
		}
		agent, err := h.Queries.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: roleID, WorkspaceID: issue.WorkspaceID})
		if err != nil {
			return nil, err
		}
		if agent.ArchivedAt.Valid || !h.canInvokeAgent(ctx, agent, "member", user, user, uuidToString(issue.WorkspaceID)) {
			return nil, reject("Frozen Feedback work role is no longer invocable")
		}
		mapping, err := h.engineeringExecutionResources(ctx, issue, agent)
		if err != nil {
			return nil, err
		}
		resources = append(resources, mapping...)
	}
	units, err := h.loadReviewUnits(ctx, issue, true)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(units))
	for i, unit := range units {
		ids[i] = unit.IssueID
	}
	payload := map[string]any{"batch_id": batchID, "expected_version": version, "planner_agent_id": policy.Planner, "execution_resources": resources, "native_unit_ids": ids}
	if scope.NeedsReproduction {
		payload["reproduction_agent_id"] = policy.Reproducer
	}
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "human", "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID), "userId": user}, "action": "authorize-feedback-work", "payload": payload})
	if err != nil {
		return nil, err
	}
	var result struct {
		Authorized bool `json:"authorized"`
	}
	if json.Unmarshal(data, &result) != nil || !result.Authorized {
		return nil, fmt.Errorf("invalid Team Feedback work authorization")
	}
	return data, nil
}

func (h *Handler) dispatchTeamFeedbackWork(ctx context.Context, item engineeringContinuation) error {
	workspace, err := util.ParseUUID(item.WorkspaceID)
	if err != nil {
		return err
	}
	id, err := util.ParseUUID(item.IssueID)
	if err != nil {
		return err
	}
	if _, err = util.ParseUUID(item.FeedbackBatchID); err != nil {
		return err
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: id, WorkspaceID: workspace})
	if err != nil {
		return err
	}
	scope, err := h.teamFeedbackWorkScope(ctx, issue, item.FeedbackBatchID, item.ExpectedSequence)
	if err != nil {
		return err
	}
	if item.AgentID != scope.Planner || item.UserID != scope.UserID || item.ExpectedRevision != scope.Revision || item.ExpectedSequence != scope.Version {
		return &engineering.Rejection{Message: "Team Feedback checkpoint changed", Conflict: true}
	}
	_, err = h.authorizeEngineeringTeamFeedbackWork(ctx, issue, item.UserID, item.FeedbackBatchID, item.ExpectedSequence)
	return err
}
