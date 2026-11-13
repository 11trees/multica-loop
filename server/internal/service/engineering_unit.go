package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var ErrEngineeringUnitIdentity = errors.New("published unit no longer matches its frozen parent, project, or plan")

type EngineeringUnitOrigin struct {
	PlanDraftID         string `json:"engineering.plan"`
	UnitKey             string `json:"engineering.unit"`
	RequirementRevision int    `json:"engineering.revision"`
	ContractHash        string `json:"engineering.contract"`
}

// CreateEngineeringUnit reuses the native create pipeline and a frozen issue ID.
// Replays observe the committed issue; they do not allocate another issue number.
func (s *IssueService) CreateEngineeringUnit(ctx context.Context, p IssueCreateParams, id pgtype.UUID, origin EngineeringUnitOrigin) (IssueCreateResult, error) {
	if !id.Valid || !p.ParentIssueID.Valid || p.AssigneeID.Valid || origin.PlanDraftID == "" || origin.UnitKey == "" || origin.RequirementRevision < 1 || len(origin.ContractHash) != 64 {
		return IssueCreateResult{}, fmt.Errorf("invalid frozen engineering unit")
	}
	lookup := func() (IssueCreateResult, error) {
		issue, err := s.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: id, WorkspaceID: p.WorkspaceID})
		if err != nil {
			return IssueCreateResult{}, err
		}
		var actual EngineeringUnitOrigin
		if json.Unmarshal(issue.Metadata, &actual) != nil || actual != origin || issue.ParentIssueID != p.ParentIssueID || issue.ProjectID != p.ProjectID || issue.CreatorID != p.CreatorID || issue.CreatorType != p.CreatorType {
			return IssueCreateResult{}, ErrEngineeringUnitIdentity
		}
		return IssueCreateResult{Issue: issue}, nil
	}
	if existing, err := lookup(); err == nil {
		return existing, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return IssueCreateResult{}, err
	}
	p.engineeringID = id
	p.engineeringOrigin = &origin
	p.AllowDuplicate = true
	result, err := s.Create(ctx, p, IssueCreateOpts{})
	if err != nil {
		if existing, lookupErr := lookup(); lookupErr == nil {
			return existing, nil
		}
	}
	return result, err
}
