package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (h *Handler) PublishEngineeringUnits(w http.ResponseWriter, r *http.Request) {
	parent, userID, ok := h.loadHumanEngineeringIssue(w, r)
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering application is not enabled")
		return
	}
	var payload struct {
		ExpectedRevision int `json:"expected_revision"`
		ExpectedSequence int `json:"expected_sequence"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil || payload.ExpectedRevision < 1 || payload.ExpectedSequence < 0 {
		writeError(w, http.StatusBadRequest, "invalid publication checkpoint")
		return
	}
	if err := h.publishEngineeringUnits(r.Context(), parent, userID, payload.ExpectedRevision, payload.ExpectedSequence); err != nil {
		engineeringControlError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"published": true})
}

func (h *Handler) publishEngineeringUnits(ctx context.Context, parent db.Issue, userID string, expectedRevision, expectedSequence int) error {
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, parent.WorkspaceID, parent.Status)
	if err != nil {
		return fmt.Errorf("parent lifecycle lookup is unavailable")
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(ctx, parent.ID)
	if err != nil {
		return fmt.Errorf("parent run lookup is unavailable")
	}
	if active || parent.TriageState.Valid || category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed {
		return &engineering.Rejection{Message: "finish active parent runs and reopen the accepted requirement before publication", Conflict: true}
	}
	result, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "publication", "actor": map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(parent.WorkspaceID), "issueId": uuidToString(parent.ID)}, "payload": map[string]int{"expected_revision": expectedRevision, "expected_sequence": expectedSequence}})
	if err != nil {
		return err
	}
	var publication struct {
		RequestedBy string `json:"requested_by"`
		Units       []struct {
			IssueID        string `json:"issueId"`
			ParentIssueID  string `json:"parentIssueId"`
			WorkspaceID    string `json:"workspaceId"`
			ParentRevision int    `json:"parentRevision"`
			PlanDraftID    string `json:"planDraftId"`
			ContractHash   string `json:"contractHash"`
			Published      bool   `json:"published"`
			Unit           struct {
				Key               string `json:"key"`
				Title             string `json:"title"`
				Actor             string `json:"actor"`
				Trigger           string `json:"trigger"`
				ObservableOutcome string `json:"observableOutcome"`
				Acceptance        string `json:"acceptance"`
			} `json:"unit"`
		} `json:"units"`
	}
	if json.Unmarshal(result, &publication) != nil || publication.RequestedBy != userID || len(publication.Units) < 1 {
		return fmt.Errorf("invalid frozen publication response")
	}
	creatorID, err := util.ParseUUID(userID)
	if err != nil {
		return fmt.Errorf("invalid publication principal")
	}
	for _, unit := range publication.Units {
		id, parseErr := util.ParseUUID(unit.IssueID)
		_, planErr := util.ParseUUID(unit.PlanDraftID)
		if parseErr != nil || planErr != nil || unit.ParentIssueID != uuidToString(parent.ID) || unit.WorkspaceID != uuidToString(parent.WorkspaceID) || unit.ParentRevision != expectedRevision || unit.Unit.Key == "" || unit.Unit.Title == "" {
			return fmt.Errorf("invalid frozen unit identity")
		}
		if unit.Published {
			if _, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: id, WorkspaceID: parent.WorkspaceID}); err != nil {
				return &engineering.Rejection{Message: "a published unit is missing; reconcile it before retrying publication", Conflict: true}
			}
		}
		description := unit.Unit.Actor + " · " + unit.Unit.Trigger + "\n\n" + unit.Unit.ObservableOutcome + "\n\n" + unit.Unit.Acceptance
		_, err = h.IssueService.CreateEngineeringUnit(ctx, service.IssueCreateParams{WorkspaceID: parent.WorkspaceID, Title: unit.Unit.Title, Description: pgtype.Text{String: description, Valid: true}, Status: "todo", Priority: "none", CreatorType: "member", CreatorID: creatorID, ParentIssueID: parent.ID, ProjectID: parent.ProjectID, PRAutoCompleteDisabled: true}, id, service.EngineeringUnitOrigin{PlanDraftID: unit.PlanDraftID, UnitKey: unit.Unit.Key, RequirementRevision: unit.ParentRevision, ContractHash: unit.ContractHash})
		if err != nil {
			if errors.Is(err, service.ErrEngineeringUnitIdentity) {
				return &engineering.Rejection{Message: err.Error(), Conflict: true}
			} else {
				return fmt.Errorf("native unit publication failed; retry the same frozen plan")
			}
		}
		_, err = h.EngineeringWorker.Call(ctx, map[string]any{"action": "publication-ack", "actor": map[string]string{"kind": "host", "workspaceId": unit.WorkspaceID, "issueId": unit.ParentIssueID}, "payload": map[string]string{"issue_id": unit.IssueID, "contract_hash": unit.ContractHash}})
		if err != nil {
			return err
		}
	}
	return nil
}
