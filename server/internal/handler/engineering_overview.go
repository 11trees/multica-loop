package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (h *Handler) loadHumanEngineeringIssue(w http.ResponseWriter, r *http.Request) (db.Issue, string, bool) {
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "a human actor is required")
		return db.Issue{}, "", false
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return db.Issue{}, "", false
	}
	userID, ok := requireUserID(w, r)
	return issue, userID, ok
}

func engineeringControlError(w http.ResponseWriter, err error) {
	var rejected *engineering.Rejection
	if errors.As(err, &rejected) {
		writeError(w, http.StatusConflict, rejected.Message)
	} else {
		writeError(w, http.StatusServiceUnavailable, "engineering application is unavailable")
	}
}

func (h *Handler) GetEngineeringOverview(w http.ResponseWriter, r *http.Request) {
	issue, userID, ok := h.loadHumanEngineeringIssue(w, r)
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "configured": false})
		return
	}
	result, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"action": "overview", "actor": map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID)}})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	var response map[string]json.RawMessage
	if json.Unmarshal(result, &response) != nil || response == nil {
		writeError(w, http.StatusServiceUnavailable, "invalid engineering overview")
		return
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(r.Context(), issue.ID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "run status lookup is unavailable")
		return
	}
	response["has_active_run"], _ = json.Marshal(active)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) RunEngineering(w http.ResponseWriter, r *http.Request) {
	issue, userID, ok := h.loadHumanEngineeringIssue(w, r)
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering application is not enabled")
		return
	}
	category, err := issuestatus.CategoryWithError(r.Context(), h.Queries, issue.WorkspaceID, issue.Status)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "issue status lookup is unavailable")
		return
	}
	if issue.TriageState.Valid || category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed {
		writeError(w, http.StatusConflict, "reopen and accept this issue before starting engineering")
		return
	}
	var payload struct {
		ExpectedRevision int `json:"expected_revision"`
		ExpectedSequence int `json:"expected_sequence"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&payload) != nil || payload.ExpectedRevision < 1 || payload.ExpectedSequence < 0 {
		writeError(w, http.StatusBadRequest, "invalid engineering checkpoint")
		return
	}
	result, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"action": "prepare-run", "actor": map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID)}, "payload": payload})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	var selection struct {
		AgentID string `json:"agent_id"`
	}
	if json.Unmarshal(result, &selection) != nil {
		writeError(w, http.StatusServiceUnavailable, "invalid engineering run selection")
		return
	}
	if _, err := util.ParseUUID(selection.AgentID); err != nil {
		writeError(w, http.StatusServiceUnavailable, "invalid engineering agent selection")
		return
	}
	agent, ok := h.loadAgentForUser(w, r, selection.AgentID)
	if !ok {
		return
	}
	if !h.canInvokeAgent(r.Context(), agent, "member", userID, userID, uuidToString(issue.WorkspaceID)) {
		h.writeDispatchBlocked(w, http.StatusForbidden, ReasonInvocationNotAllowed)
		return
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(r.Context(), issue.ID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "run status lookup is unavailable")
		return
	}
	if active {
		writeError(w, http.StatusConflict, "an issue run is still active; wait for it to finish before starting engineering")
		return
	}
	mappings, err := h.engineeringExecutionResources(r.Context(), issue, agent)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	checked, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"action": "prepare-run", "actor": map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID)}, "payload": map[string]any{"expected_revision": payload.ExpectedRevision, "expected_sequence": payload.ExpectedSequence, "execution_resources": mappings}})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	var confirmed struct {
		AgentID string `json:"agent_id"`
	}
	if json.Unmarshal(checked, &confirmed) != nil || confirmed.AgentID != selection.AgentID {
		writeError(w, http.StatusServiceUnavailable, "engineering role changed while preparing the run")
		return
	}
	task, err := h.TaskService.EnqueueEngineeringRun(r.Context(), issue, agent.ID, parseUUID(userID), "Continue the configured engineering chain with multica engineering start. Preserve its frozen inputs and current phase.")
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, taskToResponse(task, uuidToString(issue.WorkspaceID)))
}
