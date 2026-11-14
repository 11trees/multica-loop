package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/projectaccess"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type engineeringContinuation struct {
	FeedbackBatchID   string   `json:"feedback_batch_id,omitempty"`
	FeedbackGroupID   string   `json:"feedback_group_id,omitempty"`
	FeedbackCommentID string   `json:"feedback_comment_id,omitempty"`
	ParentIssueID     string   `json:"parent_issue_id,omitempty"`
	UnitIssueIDs      []string `json:"unit_issue_ids,omitempty"`
	WorkspaceID       string   `json:"workspace_id"`
	IssueID           string   `json:"issue_id"`
	AgentID           string   `json:"agent_id"`
	UserID            string   `json:"user_id"`
	TaskID            string   `json:"task_id"`
	ExpectedRevision  int      `json:"expected_revision"`
	ExpectedSequence  int      `json:"expected_sequence"`
	Reason            string   `json:"reason"`
}

// ReconcileEngineering derives work from persisted handoffs and answered batches.
// It never treats task completion or output text as a chain conclusion.
func (h *Handler) ReconcileEngineering(ctx context.Context) error {
	if h.EngineeringWorker == nil {
		return nil
	}
	result, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "coordinator"}, "action": "continuations"})
	if err != nil {
		return err
	}
	var pending []engineeringContinuation
	if err := json.Unmarshal(result, &pending); err != nil {
		return fmt.Errorf("invalid engineering continuations: %w", err)
	}
	var failures []error
	for _, item := range pending {
		if err := h.dispatchEngineeringContinuation(ctx, item); err != nil {
			slog.WarnContext(ctx, "engineering continuation waiting", "issue_id", item.IssueID, "task_id", item.TaskID, "error", err)
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (h *Handler) dispatchEngineeringContinuation(ctx context.Context, item engineeringContinuation) error {
	if item.Reason == "feedback_restore" {
		return h.restoreEngineeringFeedback(ctx, item)
	}
	if item.Reason == "feedback_report_next" || item.Reason == "feedback_verify_next" || item.Reason == "feedback_review_next" || item.Reason == "feedback_forward" || item.Reason == "review_forward" || item.Reason == "review_next" {
		return h.dispatchRequirementReview(ctx, item)
	}
	if item.Reason == "unit_activation" || item.Reason == "unit_passed" {
		return h.dispatchManagedUnit(ctx, item)
	}
	workspaceID, err := util.ParseUUID(item.WorkspaceID)
	if err != nil {
		return err
	}
	issueID, err := util.ParseUUID(item.IssueID)
	if err != nil {
		return err
	}
	agentID, err := util.ParseUUID(item.AgentID)
	if err != nil {
		return err
	}
	userID, err := util.ParseUUID(item.UserID)
	if err != nil {
		return err
	}
	taskID, err := util.ParseUUID(item.TaskID)
	if err != nil {
		return err
	}
	if item.ExpectedRevision < 1 || item.ExpectedSequence < 0 || (item.Reason != "business_ready" && item.Reason != "feedback_verify_ready" && item.Reason != "feedback_work_ready" && item.Reason != "feedback_ready" && item.Reason != "reproduction_handoff" && item.Reason != "review_ready" && item.Reason != "unit_ready" && item.Reason != "context_handoff" && item.Reason != "human_answers" && item.Reason != "development_handoff" && item.Reason != "verification_rework" && item.Reason != "analysis_handoff" && item.Reason != "verification_reanalysis") {
		return fmt.Errorf("invalid engineering continuation checkpoint")
	}
	if existing, err := h.Queries.GetAgentTask(ctx, taskID); err == nil {
		if existing.IssueID != issueID || existing.AgentID != agentID || existing.OriginatorUserID != userID {
			return fmt.Errorf("engineering continuation identity changed")
		}
		return nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: workspaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
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
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(ctx, issueID)
	if err != nil {
		return err
	}
	if active {
		return nil
	}
	if item.ParentIssueID != "" {
		idle, err := h.managedRunsIdle(ctx, issue)
		if err != nil {
			return err
		}
		if !idle {
			return nil
		}
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
		return fmt.Errorf("engineering project is no longer visible")
	}
	agent, err := h.Queries.GetAgent(ctx, agentID)
	if err != nil {
		return err
	}
	if agent.WorkspaceID != workspaceID || agent.ArchivedAt.Valid || !h.canInvokeAgent(ctx, agent, "member", item.UserID, item.UserID, item.WorkspaceID) {
		return fmt.Errorf("engineering agent is no longer invocable")
	}
	mappings, err := h.engineeringExecutionResources(ctx, issue, agent)
	if err != nil {
		return err
	}
	selected, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "prepare-run", "actor": map[string]string{"kind": "human", "userId": item.UserID, "workspaceId": item.WorkspaceID, "issueId": item.IssueID}, "payload": map[string]any{"expected_revision": item.ExpectedRevision, "expected_sequence": item.ExpectedSequence, "execution_resources": mappings}})
	if err != nil {
		return err
	}
	var selection struct {
		AgentID     string                   `json:"agent_id"`
		ReviewUnits *[]engineeringReviewUnit `json:"review_units"`
	}
	if json.Unmarshal(selected, &selection) != nil || selection.AgentID != item.AgentID {
		return fmt.Errorf("engineering role changed before continuation")
	}
	if err := requireEngineeringBusinessProject(issue, selected); err != nil {
		return err
	}
	if selection.ReviewUnits != nil {
		if err := h.reviewNativeUnits(ctx, issue, *selection.ReviewUnits, true); err != nil {
			return err
		}
	}
	_, err = h.TaskService.EnqueueEngineeringContinuation(ctx, issue, agentID, userID, taskID, "Continue the configured engineering chain with multica engineering start. Preserve its frozen inputs and current phase.")
	return err
}
