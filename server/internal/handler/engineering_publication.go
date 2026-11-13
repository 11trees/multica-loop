package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
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
	category, err := issuestatus.CategoryWithError(r.Context(), h.Queries, parent.WorkspaceID, parent.Status)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "parent lifecycle lookup is unavailable")
		return
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(r.Context(), parent.ID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "parent run lookup is unavailable")
		return
	}
	if active || parent.TriageState.Valid || category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed {
		writeError(w, http.StatusConflict, "finish active parent runs and reopen the accepted requirement before publication")
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
	result, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"action": "publication", "actor": map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(parent.WorkspaceID), "issueId": uuidToString(parent.ID)}, "payload": payload})
	if err != nil {
		engineeringControlError(w, err)
		return
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
	if json.Unmarshal(result, &publication) != nil || publication.RequestedBy != userID || len(publication.Units) < 1 || len(publication.Units) > 50 {
		writeError(w, http.StatusServiceUnavailable, "invalid frozen publication response")
		return
	}
	creatorID, err := util.ParseUUID(userID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "invalid publication principal")
		return
	}
	for _, unit := range publication.Units {
		id, parseErr := util.ParseUUID(unit.IssueID)
		_, planErr := util.ParseUUID(unit.PlanDraftID)
		if parseErr != nil || planErr != nil || unit.ParentIssueID != uuidToString(parent.ID) || unit.WorkspaceID != uuidToString(parent.WorkspaceID) || unit.ParentRevision != payload.ExpectedRevision || unit.Unit.Key == "" || unit.Unit.Title == "" {
			writeError(w, http.StatusServiceUnavailable, "invalid frozen unit identity")
			return
		}
		if unit.Published {
			if _, err := h.Queries.GetIssueInWorkspace(r.Context(), db.GetIssueInWorkspaceParams{ID: id, WorkspaceID: parent.WorkspaceID}); err != nil {
				writeError(w, http.StatusConflict, "a published unit is missing; reconcile it before retrying publication")
				return
			}
		}
		description := unit.Unit.Actor + " · " + unit.Unit.Trigger + "\n\n" + unit.Unit.ObservableOutcome + "\n\n" + unit.Unit.Acceptance
		_, err = h.IssueService.CreateEngineeringUnit(r.Context(), service.IssueCreateParams{WorkspaceID: parent.WorkspaceID, Title: unit.Unit.Title, Description: pgtype.Text{String: description, Valid: true}, Status: "todo", Priority: "none", CreatorType: "member", CreatorID: creatorID, ParentIssueID: parent.ID, ProjectID: parent.ProjectID, PRAutoCompleteDisabled: true}, id, service.EngineeringUnitOrigin{PlanDraftID: unit.PlanDraftID, UnitKey: unit.Unit.Key, RequirementRevision: unit.ParentRevision, ContractHash: unit.ContractHash})
		if err != nil {
			if errors.Is(err, service.ErrEngineeringUnitIdentity) {
				writeError(w, http.StatusConflict, err.Error())
			} else {
				writeError(w, http.StatusServiceUnavailable, "native unit publication failed; retry the same frozen plan")
			}
			return
		}
		_, err = h.EngineeringWorker.Call(r.Context(), map[string]any{"action": "publication-ack", "actor": map[string]string{"kind": "host", "workspaceId": unit.WorkspaceID, "issueId": unit.ParentIssueID}, "payload": map[string]string{"issue_id": unit.IssueID, "contract_hash": unit.ContractHash}})
		if err != nil {
			engineeringControlError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"published": true})
}
