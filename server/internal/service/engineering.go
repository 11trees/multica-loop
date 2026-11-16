package service

import (
	"context"
	"errors"
	"fmt"
	"github.com/google/uuid"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/attribution"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type EngineeringContinuationPlan struct {
	Params      db.CreateAgentTaskParams
	attribution attribution.Result
}

// Preparation shares the ordinary enqueue's attribution, access and resource
// rules. The caller creates Params in its ownership transaction before waking.
func (s *TaskService) PrepareEngineeringContinuation(ctx context.Context, issue db.Issue, agentID, userID, taskID pgtype.UUID, note string) (EngineeringContinuationPlan, error) {
	params, attr, err := s.prepareMentionTaskWithCommentPlan(ctx, issue, agentID, pgtype.UUID{}, nil, false, pgtype.UUID{}, false, note, userID, pgtype.UUID{}, OriginDerived, false, taskID)
	return EngineeringContinuationPlan{Params: params, attribution: attr}, err
}
func (s *TaskService) EngineeringContinuationPublished(ctx context.Context, plan EngineeringContinuationPlan, task db.AgentTaskQueue) {
	s.RecordHumanDelegation(ctx, plan.attribution)
	s.NotifyEngineeringContinuation(ctx, task)
}
func (s *TaskService) NotifyEngineeringContinuation(ctx context.Context, task db.AgentTaskQueue) {
	s.broadcastTaskEvent(ctx, protocol.EventTaskQueued, task)
	s.NotifyTaskEnqueued(ctx, task)
}

// EnqueueEngineeringRun names the frozen role without changing the issue assignee.
func (s *TaskService) EnqueueEngineeringRun(ctx context.Context, issue db.Issue, agentID, actorUserID pgtype.UUID, note string) (db.AgentTaskQueue, error) {
	return s.enqueueMentionTaskWithCommentPlan(ctx, issue, agentID, pgtype.UUID{}, nil, false, pgtype.UUID{}, false, note, actorUserID, pgtype.UUID{}, OriginNamed, false, false, pgtype.UUID{Bytes: uuid.New(), Valid: true})
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
