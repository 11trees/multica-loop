package handler

import (
	"encoding/json"
	"net/http"
)

func (h *Handler) AuthorizeEngineeringFeedbackWork(w http.ResponseWriter, r *http.Request) {
	parent, userID, ok := h.loadHumanEngineeringIssue(w, r)
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering is not enabled")
		return
	}
	var payload struct {
		BatchID         string `json:"batch_id"`
		ExpectedVersion int    `json:"expected_version"`
		PlannerID       string `json:"planner_agent_id"`
		ReproducerID    string `json:"reproduction_agent_id,omitempty"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil || payload.ExpectedVersion < 0 {
		writeError(w, http.StatusBadRequest, "invalid feedback work authorization")
		return
	}
	batchID, ok := parseUUIDOrBadRequest(w, payload.BatchID, "batch_id")
	if !ok {
		return
	}
	units, err := h.loadReviewUnits(r.Context(), parent, true)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	ids := []string{payload.PlannerID}
	if payload.ReproducerID != "" {
		ids = append(ids, payload.ReproducerID)
	}
	resources := make([]map[string]string, 0, len(ids))
	roles := make([]string, 0, len(ids))
	for _, id := range ids {
		agent, ok := h.loadAgentForUser(w, r, id)
		if !ok {
			return
		}
		if !h.canInvokeAgent(r.Context(), agent, "member", userID, userID, uuidToString(parent.WorkspaceID)) {
			writeError(w, http.StatusForbidden, "feedback work role is not invocable")
			return
		}
		mapping, err := h.engineeringExecutionResources(r.Context(), parent, agent)
		if err != nil {
			engineeringControlError(w, err)
			return
		}
		resources = append(resources, mapping...)
		roles = append(roles, uuidToString(agent.ID))
	}
	nativeIDs := make([]string, len(units))
	for i, unit := range units {
		nativeIDs[i] = unit.IssueID
	}
	input := map[string]any{"batch_id": uuidToString(batchID), "expected_version": payload.ExpectedVersion, "planner_agent_id": roles[0], "execution_resources": resources, "native_unit_ids": nativeIDs}
	if len(roles) == 2 {
		input["reproduction_agent_id"] = roles[1]
	}
	result, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"actor": map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(parent.WorkspaceID), "issueId": uuidToString(parent.ID)}, "action": "authorize-feedback-work", "payload": input})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
