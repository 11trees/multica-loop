package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// EnqueueEngineeringRun names the frozen role without changing the issue assignee.
func (s *TaskService) EnqueueEngineeringRun(ctx context.Context, issue db.Issue, agentID, actorUserID pgtype.UUID, note string) (db.AgentTaskQueue, error) {
	return s.enqueueMentionTask(ctx, issue, agentID, pgtype.UUID{}, false, pgtype.UUID{}, false, note, actorUserID, pgtype.UUID{}, OriginNamed)
}

// The stable task ID bridges a durable engineering checkpoint to the native queue.
// Retrying dispatch after a host restart observes the same task, even if terminal.
func (s *TaskService) EnqueueEngineeringContinuation(ctx context.Context, issue db.Issue, agentID, actorUserID, taskID pgtype.UUID, note string) (db.AgentTaskQueue, error) {
	lookup := func() (db.AgentTaskQueue, error) {
		task, err := s.Queries.GetAgentTask(ctx, taskID)
		if err == nil && (task.IssueID != issue.ID || task.AgentID != agentID || task.OriginatorUserID != actorUserID) {
			return db.AgentTaskQueue{}, fmt.Errorf("engineering continuation identity changed")
		}
		return task, err
	}
	if task, err := lookup(); err == nil {
		return task, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return db.AgentTaskQueue{}, err
	}
	task, err := s.enqueueMentionTaskWithCommentPlan(ctx, issue, agentID, pgtype.UUID{}, nil, false, pgtype.UUID{}, false, note, actorUserID, pgtype.UUID{}, OriginDerived, false, false, taskID)
	if err != nil {
		if existing, lookupErr := lookup(); lookupErr == nil {
			return existing, nil
		}
	}
	return task, err
}
