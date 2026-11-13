package service

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// EnqueueEngineeringRun names the frozen role without changing the issue assignee.
func (s *TaskService) EnqueueEngineeringRun(ctx context.Context, issue db.Issue, agentID, actorUserID pgtype.UUID, note string) (db.AgentTaskQueue, error) {
	return s.enqueueMentionTask(ctx, issue, agentID, pgtype.UUID{}, false, pgtype.UUID{}, false, note, actorUserID, pgtype.UUID{}, OriginNamed)
}
