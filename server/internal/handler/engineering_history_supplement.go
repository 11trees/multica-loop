package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

func (h *Handler) engineeringSupplementAvailable(r *http.Request) bool {
	return h.engineeringHistoryAvailable(r) && h.EngineeringSupplementWorker != nil && historyDigest(h.cfg.EngineeringHistorySupplementHash)
}
func (h *Handler) engineeringSupplementHash(r *http.Request) string {
	if h.engineeringSupplementAvailable(r) {
		return h.cfg.EngineeringHistorySupplementHash
	}
	return ""
}
func (h *Handler) supplementRead(w http.ResponseWriter, r *http.Request, input map[string]any) {
	if !h.engineeringSupplementAvailable(r) {
		writeError(w, 403, "supplement requires the configured local human and archive")
		return
	}
	input["expected_archive_hash"] = h.cfg.EngineeringHistoryHash
	input["expected_hash"] = h.cfg.EngineeringHistorySupplementHash
	raw, err := h.EngineeringSupplementWorker.Call(r.Context(), input)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	var result struct {
		Historical *bool  `json:"historical_only"`
		Execution  *bool  `json:"execution_authorized"`
		Archive    string `json:"archive_hash"`
		Hash       string `json:"hash"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Historical == nil || !*result.Historical || result.Execution == nil || *result.Execution || result.Archive != h.cfg.EngineeringHistoryHash || result.Hash != h.cfg.EngineeringHistorySupplementHash {
		writeError(w, 503, "supplement identity changed")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, json.RawMessage(raw))
}
func (h *Handler) GetEngineeringSupplementCatalog(w http.ResponseWriter, r *http.Request) {
	h.supplementRead(w, r, map[string]any{"action": "catalog"})
}
func supplementDatabase(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	id := chi.URLParam(r, "databaseID")
	if !historyDigest(id) {
		writeError(w, 400, "invalid historical database identity")
		return nil, false
	}
	return map[string]any{"database_id": id}, true
}
func (h *Handler) ListEngineeringSupplementTasks(w http.ResponseWriter, r *http.Request) {
	input, ok := supplementDatabase(w, r)
	if !ok {
		return
	}
	input["action"] = "tasks"
	if search := r.URL.Query().Get("search"); search != "" {
		if len(search) > 800 {
			writeError(w, 400, "search is too long")
			return
		}
		input["search"] = search
	}
	if value := r.URL.Query().Get("offset"); value != "" {
		offset, err := strconv.Atoi(value)
		if err != nil || offset < 0 || offset > 1000000 {
			writeError(w, 400, "invalid historical offset")
			return
		}
		input["offset"] = offset
	}
	h.supplementRead(w, r, input)
}
func (h *Handler) GetEngineeringSupplementTask(w http.ResponseWriter, r *http.Request) {
	input, ok := supplementDatabase(w, r)
	if !ok {
		return
	}
	input["action"] = "task"
	input["task_id"] = chi.URLParam(r, "sourceTaskID")
	h.supplementRead(w, r, input)
}
func (h *Handler) GetEngineeringSupplementDocument(w http.ResponseWriter, r *http.Request) {
	input, ok := supplementDatabase(w, r)
	if !ok {
		return
	}
	input["action"] = "document"
	input["task_id"] = chi.URLParam(r, "sourceTaskID")
	input["document_id"] = chi.URLParam(r, "sourceDocumentID")
	h.supplementRead(w, r, input)
}
func (h *Handler) GetEngineeringSupplementFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "fileID")
	if !historyDigest(id) {
		writeError(w, 400, "invalid historical file identity")
		return
	}
	input := map[string]any{"action": "file", "file_id": id}
	for _, key := range []string{"offset", "length"} {
		if value := r.URL.Query().Get(key); value != "" {
			number, err := strconv.Atoi(value)
			limit := 268435456
			if key == "length" {
				limit = 1048576
			}
			if err != nil || number < 0 || number > limit || key == "length" && number == 0 {
				writeError(w, 400, "invalid historical file range")
				return
			}
			input[key] = number
		}
	}
	h.supplementRead(w, r, input)
}
