package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Physical facts use the runtime's control-plane credential, never a task token.
func (h *Handler) RecordEngineeringProcess(w http.ResponseWriter, r *http.Request) {
	path := middleware.DaemonAuthPathFromContext(r.Context())
	if path != middleware.DaemonAuthPathPAT && path != middleware.DaemonAuthPathJWT {
		writeError(w, http.StatusForbidden, "a control-plane runtime credential is required")
		return
	}
	task, scope, ok := h.requireDaemonTaskAccessWithScope(w, r, chi.URLParam(r, "taskId"))
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering application is not enabled")
		return
	}
	var request struct {
		Operation     string `json:"operation"`
		AllocationID  string `json:"allocation_id"`
		DispatchedAt  string `json:"dispatched_at"`
		HostID        string `json:"host_id"`
		PID           *int   `json:"pid,omitempty"`
		Marker        string `json:"marker,omitempty"`
		GroupID       *int   `json:"group_id,omitempty"`
		ExitConfirmed *bool  `json:"exit_confirmed,omitempty"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil {
		writeError(w, http.StatusBadRequest, "invalid physical process record")
		return
	}
	if _, ok := parseUUIDOrBadRequest(w, request.AllocationID, "allocation_id"); !ok {
		return
	}
	claim, err := time.Parse(time.RFC3339Nano, request.DispatchedAt)
	if err != nil || !task.DispatchedAt.Valid || !claim.Equal(task.DispatchedAt.Time) || !task.IssueID.Valid || !task.RuntimeID.Valid {
		writeError(w, http.StatusConflict, "physical process record belongs to a stale native claim")
		return
	}
	if request.Operation != "exit" && task.Status != "running" {
		writeError(w, http.StatusConflict, "inactive native claim cannot launch or bind a process")
		return
	}
	actor := map[string]string{"kind": "daemon", "workspaceId": scope.WorkspaceID, "issueId": uuidToString(task.IssueID), "agentId": uuidToString(task.AgentID), "attemptId": uuidToString(task.ID) + ":" + strconv.FormatInt(claim.UnixMicro(), 10)}
	payload := map[string]any{"operation": request.Operation, "allocation_id": request.AllocationID, "runtime_id": uuidToString(task.RuntimeID), "host_id": request.HostID}
	switch request.Operation {
	case "reserve":
		if request.PID != nil || request.Marker != "" || request.GroupID != nil || request.ExitConfirmed != nil {
			writeError(w, http.StatusBadRequest, "reserve cannot declare process facts")
			return
		}
		issue, err := h.Queries.GetIssueInWorkspace(r.Context(), db.GetIssueInWorkspaceParams{ID: task.IssueID, WorkspaceID: parseUUID(scope.WorkspaceID)})
		if err != nil {
			writeError(w, http.StatusConflict, "native issue is unavailable")
			return
		}
		if issue.ProjectID.Valid {
			actor["projectId"] = uuidToString(issue.ProjectID)
		}
		payload["provider"] = "codex"
	case "bind":
		if request.PID == nil || request.GroupID == nil || request.Marker == "" || request.ExitConfirmed != nil {
			writeError(w, http.StatusBadRequest, "bind requires the actual PID, group and birth marker")
			return
		}
		payload["pid"], payload["group_id"], payload["marker"] = *request.PID, *request.GroupID, request.Marker
	case "exit":
		if request.PID == nil || request.ExitConfirmed == nil || request.Marker != "" || request.GroupID != nil {
			writeError(w, http.StatusBadRequest, "exit requires an explicit process cleanup fact")
			return
		}
		payload["pid"], payload["exit_confirmed"] = *request.PID, *request.ExitConfirmed
	default:
		writeError(w, http.StatusBadRequest, "unknown physical process operation")
		return
	}
	result, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"action": "process", "actor": actor, "payload": payload})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
