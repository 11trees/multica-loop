package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/engineering"
)

func (h *Handler) invokeEngineering(w http.ResponseWriter, r *http.Request, action string, actor map[string]string) {
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering application is not enabled")
		return
	}
	var payload json.RawMessage
	if action != "read" && action != "start" {
		var err error
		payload, err = io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil || !json.Valid(payload) {
			writeError(w, http.StatusBadRequest, "invalid engineering request body")
			return
		}
	}
	if action == "configure" {
		var selection struct {
			AgentID     string `json:"agent_id"`
			DeveloperID string `json:"developer_agent_id"`
		}
		if err := json.Unmarshal(payload, &selection); err != nil {
			writeError(w, http.StatusBadRequest, "invalid engineering agent selection")
			return
		}
		if _, ok := h.loadAgentForUser(w, r, selection.AgentID); !ok {
			return
		}
		if selection.DeveloperID != "" {
			if _, ok := h.loadAgentForUser(w, r, selection.DeveloperID); !ok {
				return
			}
		}
	}
	result, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"actor": actor, "action": action, "payload": payload})
	if err != nil {
		var rejected *engineering.Rejection
		if errors.As(err, &rejected) {
			status := http.StatusUnprocessableEntity
			if rejected.Conflict {
				status = http.StatusConflict
			}
			writeError(w, status, rejected.Message)
		} else {
			writeError(w, http.StatusServiceUnavailable, "engineering application is unavailable")
		}
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) humanEngineering(w http.ResponseWriter, r *http.Request, action string) {
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "a human actor is required")
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	h.invokeEngineering(w, r, action, map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID)})
}

func (h *Handler) taskEngineering(w http.ResponseWriter, r *http.Request, action string) {
	run, ok := h.loadEngineeringRun(w, r)
	if !ok {
		return
	}
	h.invokeEngineering(w, r, action, map[string]string{"kind": "task", "agentId": run.AgentID, "attemptId": run.AttemptID, "workspaceId": run.WorkspaceID, "issueId": run.IssueID})
}

func (h *Handler) ConfigureEngineeringVerification(w http.ResponseWriter, r *http.Request) {
	h.humanEngineering(w, r, "configure")
}
func (h *Handler) GetHumanEngineeringVerification(w http.ResponseWriter, r *http.Request) {
	h.humanEngineering(w, r, "read")
}
func (h *Handler) AnswerEngineeringVerification(w http.ResponseWriter, r *http.Request) {
	h.humanEngineering(w, r, "answer")
}
func (h *Handler) AbandonEngineeringVerification(w http.ResponseWriter, r *http.Request) {
	h.humanEngineering(w, r, "abandon")
}
func (h *Handler) StartEngineeringVerification(w http.ResponseWriter, r *http.Request) {
	h.taskEngineering(w, r, "start")
}
func (h *Handler) GetEngineeringVerification(w http.ResponseWriter, r *http.Request) {
	h.taskEngineering(w, r, "read")
}
func (h *Handler) CommandEngineeringVerification(w http.ResponseWriter, r *http.Request) {
	h.taskEngineering(w, r, "command")
}
