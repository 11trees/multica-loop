package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestEngineeringTeamOwnershipRejectsGenericQueueEntrypoints(t *testing.T) {
	issue := db.Issue{}
	called := 0
	s := &TaskService{EngineeringTeamOwnsIssue: func(context.Context, db.Issue) (bool, error) { called++; return true, nil }}
	calls := []func() error{
		func() error {
			_, err := s.EnqueueTaskForIssueByActor(context.Background(), issue, pgtype.UUID{})
			return err
		},
		func() error {
			_, err := s.EnqueueTaskForMention(context.Background(), issue, pgtype.UUID{}, pgtype.UUID{}, OriginDerived)
			return err
		},
		func() error {
			_, err := s.EnqueueTaskForSquadLeader(context.Background(), issue, pgtype.UUID{}, pgtype.UUID{}, pgtype.UUID{}, OriginDerived)
			return err
		},
	}
	for _, call := range calls {
		if err := call(); err == nil {
			t.Fatal("generic entrypoint bypassed Team workflow")
		}
	}
	if called != len(calls) {
		t.Fatal("ownership guard did not cover every queue path")
	}
	unavailable := errors.New("Team routing unavailable")
	s.EngineeringTeamOwnsIssue = func(context.Context, db.Issue) (bool, error) { return false, unavailable }
	if err := calls[1](); !errors.Is(err, unavailable) {
		t.Fatal("unavailable routing became a generic run", err)
	}
}
