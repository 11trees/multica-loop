package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type engineeringCompletionError struct {
	message     string
	unavailable bool
}

func (e *engineeringCompletionError) Error() string { return e.message }

// Both human and agent issue writes use this boundary after workflow remapping.
func (h *Handler) requireEngineeringCompletion(ctx context.Context, workspaceID pgtype.UUID, params db.UpdateIssueParams) error {
	return h.requireEngineeringCompletionWithCatalog(ctx, h.Queries, workspaceID, params)
}

func (h *Handler) requireEngineeringCompletionWithCatalog(ctx context.Context, catalog issuestatus.Querier, workspaceID pgtype.UUID, params db.UpdateIssueParams) error {
	if h.EngineeringWorker == nil || !params.Status.Valid {
		return nil
	}
	category, err := issuestatus.CategoryWithError(ctx, catalog, workspaceID, params.Status.String)
	if err != nil {
		return &engineeringCompletionError{message: "engineering completion status lookup is unavailable", unavailable: true}
	}
	if category != issuestatus.CategoryDone {
		return nil
	}
	result, err := h.EngineeringWorker.Call(ctx, map[string]any{
		"actor":  map[string]string{"kind": "host", "workspaceId": uuidToString(workspaceID), "issueId": uuidToString(params.ID)},
		"action": "completion",
	})
	if err != nil {
		var rejected *engineering.Rejection
		if errors.As(err, &rejected) {
			return &engineeringCompletionError{message: rejected.Message}
		}
		return &engineeringCompletionError{message: "engineering completion validation is unavailable", unavailable: true}
	}
	var permission struct {
		Configured  *bool                    `json:"configured"`
		Allowed     *bool                    `json:"allowed"`
		ReviewUnits *[]engineeringReviewUnit `json:"review_units"`
	}
	if json.Unmarshal(result, &permission) != nil || permission.Configured == nil || permission.Allowed == nil {
		return &engineeringCompletionError{message: "engineering completion validation returned an invalid result", unavailable: true}
	}
	if !*permission.Allowed {
		return &engineeringCompletionError{message: "independent verification has not authorized issue completion"}
	}
	if permission.ReviewUnits != nil {
		parent, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: params.ID, WorkspaceID: workspaceID})
		if err != nil {
			return &engineeringCompletionError{message: "native requirement review lookup is unavailable", unavailable: true}
		}
		if params.ProjectID != parent.ProjectID {
			return &engineeringCompletionError{message: "requirement project must remain the reviewed native project"}
		}
		if err := h.reviewNativeIdle(ctx, parent, *permission.ReviewUnits, false); err != nil {
			return &engineeringCompletionError{message: err.Error()}
		}
	}
	return nil
}

func writeEngineeringCompletionError(w http.ResponseWriter, err error) bool {
	var rejected *engineeringCompletionError
	if !errors.As(err, &rejected) {
		return false
	}
	status := http.StatusConflict
	if rejected.unavailable {
		status = http.StatusServiceUnavailable
	}
	writeError(w, status, rejected.message)
	return true
}
