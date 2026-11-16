package service

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issueposition"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"strings"
)

// StageHistoryDraft writes an inert Team assignment in the caller's cohort
// transaction. It uses native numbering/position/quota rules and deliberately
// has no assignment enqueue or post-commit effects.
func (s *IssueService) StageHistoryDraft(ctx context.Context, tx pgx.Tx, workspace, project, team, human pgtype.UUID, title, description string) (db.Issue, error) {
	q := s.Queries.WithTx(tx)
	if strings.TrimSpace(title) == "" || len([]rune(title)) > 1024 {
		return db.Issue{}, errors.New("source task title is unavailable")
	}
	nativeProject, err := q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: project, WorkspaceID: workspace})
	if err != nil || nativeProject.Status == "completed" || nativeProject.Status == "cancelled" {
		return db.Issue{}, ErrProjectNotFound
	}
	squad, err := q.GetSquadInWorkspace(ctx, db.GetSquadInWorkspaceParams{ID: team, WorkspaceID: workspace})
	if err != nil || squad.ArchivedAt.Valid {
		return db.Issue{}, errors.New("prepared Team is unavailable")
	}
	if definition, resolveErr := s.createWorkflow(ctx, q, IssueCreateParams{WorkspaceID: workspace, ProjectID: project}); resolveErr != nil {
		return db.Issue{}, resolveErr
	} else if definition != nil && definition.Limits() && !definition.Has("backlog") {
		return db.Issue{}, errors.New("native project workflow needs backlog for migration drafts")
	}
	number, err := AllocateIssueNumber(ctx, q, workspace, ResolveIssueCountPolicy(ctx, s.Entitlements, workspace))
	if err != nil {
		return db.Issue{}, err
	}
	position, err := issueposition.NextTopPosition(ctx, tx, workspace, "backlog")
	if err != nil {
		return db.Issue{}, err
	}
	return q.CreateIssue(ctx, db.CreateIssueParams{ID: dbid.NewV7(), WorkspaceID: workspace, Title: title, Description: pgtype.Text{String: description, Valid: true}, Status: "backlog", Priority: "none", AssigneeType: pgtype.Text{String: "squad", Valid: true}, AssigneeID: team, CreatorType: "member", CreatorID: human, ProjectID: project, Number: number, Position: position})
}
