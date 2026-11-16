package handler

import (
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"net/http"
	"strconv"
)

func (h *Handler) engineeringHistoryAvailable(r *http.Request) bool {
	return h.cfg.LocalAuthEnabled && h.EngineeringHistoryWorker != nil && h.cfg.EngineeringHistoryHash != "" && !isMachineCredentialActor(r) && r.Header.Get("X-User-ID") == localUserID && h.resolveWorkspaceID(r) == localWorkspaceID
}
func (h *Handler) EngineeringHistoryAvailability(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": h.engineeringHistoryAvailable(r)})
}
func (h *Handler) engineeringHistoryRead(w http.ResponseWriter, r *http.Request, payload map[string]any) {
	if !h.engineeringHistoryAvailable(r) {
		writeError(w, http.StatusForbidden, "historical records require the configured local workspace owner")
		return
	}
	payload["expected_hash"] = h.cfg.EngineeringHistoryHash
	result, err := h.EngineeringHistoryWorker.Call(r.Context(), payload)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	var facts struct {
		HistoricalOnly bool `json:"historical_only"`
		Source         struct {
			Hash string `json:"hash"`
		} `json:"source"`
	}
	if json.Unmarshal(result, &facts) != nil || !facts.HistoricalOnly || facts.Source.Hash != h.cfg.EngineeringHistoryHash {
		writeError(w, http.StatusServiceUnavailable, "historical archive identity changed")
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(result))
}
func (h *Handler) ListEngineeringHistory(w http.ResponseWriter, r *http.Request) {
	input := map[string]any{"action": "list"}
	if project := r.URL.Query().Get("project_id"); project != "" {
		if len(project) > 500 {
			writeError(w, http.StatusBadRequest, "invalid source project")
			return
		}
		input["project_id"] = project
	}
	if search := r.URL.Query().Get("search"); search != "" {
		if len(search) > 800 {
			writeError(w, http.StatusBadRequest, "search is too long")
			return
		}
		input["search"] = search
	}
	if value := r.URL.Query().Get("offset"); value != "" {
		n, err := strconv.Atoi(value)
		if err != nil || n < 0 || n > 1000000 {
			writeError(w, http.StatusBadRequest, "invalid history offset")
			return
		}
		input["offset"] = n
	}
	h.engineeringHistoryRead(w, r, input)
}
func (h *Handler) GetEngineeringHistoryTask(w http.ResponseWriter, r *http.Request) {
	h.engineeringHistoryRead(w, r, map[string]any{"action": "task", "task_id": chi.URLParam(r, "sourceTaskID")})
}
func (h *Handler) GetEngineeringHistoryDocument(w http.ResponseWriter, r *http.Request) {
	h.engineeringHistoryRead(w, r, map[string]any{"action": "document", "task_id": chi.URLParam(r, "sourceTaskID"), "document_id": chi.URLParam(r, "sourceDocumentID")})
}
func (h *Handler) GetEngineeringHistoryPacket(w http.ResponseWriter, r *http.Request) {
	h.engineeringHistoryRead(w, r, map[string]any{"action": "packet", "task_id": chi.URLParam(r, "sourceTaskID")})
}
