package service

import (
	"context"
	"encoding/json"
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
func (s *TaskService) EnqueueEngineeringRun(ctx context.Context, issue db.Issue, agentID, actorUserID pgtype.UUID, note string, recovery ...*EngineeringRecoveryExecution) (db.AgentTaskQueue, error) {
	if len(recovery) > 0 && recovery[0] != nil {
		return s.enqueueEngineeringRecovery(ctx, issue, agentID, actorUserID, pgtype.UUID{Bytes: uuid.New(), Valid: true}, note, OriginNamed, recovery[0])
	}
	return s.enqueueMentionTaskWithCommentPlan(ctx, issue, agentID, pgtype.UUID{}, nil, false, pgtype.UUID{}, false, note, actorUserID, pgtype.UUID{}, OriginNamed, false, false, pgtype.UUID{Bytes: uuid.New(), Valid: true})
}

// The stable task ID bridges a durable engineering checkpoint to the native queue.
// Retrying dispatch after a host restart observes the same task, even if terminal.
func (s *TaskService) EnqueueEngineeringContinuation(ctx context.Context, issue db.Issue, agentID, actorUserID, taskID pgtype.UUID, note string, recovery ...*EngineeringRecoveryExecution) (db.AgentTaskQueue, error) {
	var hint *EngineeringRecoveryExecution
	if len(recovery) > 0 {
		hint = recovery[0]
	}
	lookup := func() (db.AgentTaskQueue, error) {
		task, err := s.Queries.GetAgentTask(ctx, taskID)
		if err == nil && (task.IssueID != issue.ID || task.AgentID != agentID || task.OriginatorUserID != actorUserID) {
			return db.AgentTaskQueue{}, fmt.Errorf("engineering continuation identity changed")
		}
		if err == nil {
			saved, e := EngineeringRecoveryFromContext(task.Context)
			if e != nil {
				return db.AgentTaskQueue{}, e
			}
			if (saved == nil) != (hint == nil) || saved != nil && hint != nil && saved.Hash != hint.Hash {
				return db.AgentTaskQueue{}, fmt.Errorf("engineering continuation recovery context changed")
			}
		}
		return task, err
	}
	if task, err := lookup(); err == nil {
		return task, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return db.AgentTaskQueue{}, err
	}
	var task db.AgentTaskQueue
	var err error
	if hint != nil {
		task, err = s.enqueueEngineeringRecovery(ctx, issue, agentID, actorUserID, taskID, note, OriginDerived, hint)
	} else {
		task, err = s.enqueueMentionTaskWithCommentPlan(ctx, issue, agentID, pgtype.UUID{}, nil, false, pgtype.UUID{}, false, note, actorUserID, pgtype.UUID{}, OriginDerived, false, false, taskID)
	}
	if err != nil {
		if existing, lookupErr := lookup(); lookupErr == nil {
			return existing, nil
		}
	}
	return task, err
}

// Uses the ordinary attribution/resource builder; only the host-owned context is added.
func (s *TaskService) enqueueEngineeringRecovery(ctx context.Context, issue db.Issue, agentID, userID, taskID pgtype.UUID, note string, origin RunOrigin, hint *EngineeringRecoveryExecution) (db.AgentTaskQueue, error) {
	if err := hint.Validate(); err != nil {
		return db.AgentTaskQueue{}, err
	}
	if hint.WorkspaceID != issue.WorkspaceID.String() || hint.IssueID != issue.ID.String() || hint.AgentID != agentID.String() || hint.UserID != userID.String() || hint.Kind != "continuation" {
		return db.AgentTaskQueue{}, fmt.Errorf("engineering recovery execution scope changed")
	}
	params, attr, err := s.prepareMentionTaskWithCommentPlan(ctx, issue, agentID, pgtype.UUID{}, nil, false, pgtype.UUID{}, false, note, userID, pgtype.UUID{}, origin, false, taskID)
	if err != nil {
		return db.AgentTaskQueue{}, err
	}
	if params.OriginatorUserID != userID {
		return db.AgentTaskQueue{}, fmt.Errorf("engineering recovery human attribution changed")
	}
	params.EngineeringRecovery, err = json.Marshal(hint)
	if err != nil {
		return db.AgentTaskQueue{}, err
	}
	task, err := s.Queries.CreateAgentTask(ctx, params)
	if err != nil {
		if isDuplicatePendingTaskErr(err) {
			return db.AgentTaskQueue{}, ErrDuplicatePendingTask
		}
		return db.AgentTaskQueue{}, err
	}
	s.EngineeringContinuationPublished(ctx, EngineeringContinuationPlan{Params: params, attribution: attr}, task)
	return task, nil
}
