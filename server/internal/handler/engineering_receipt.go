package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/redact"
)

func (h *Handler) CaptureEngineeringReceipt(w http.ResponseWriter, r *http.Request) {
	// Remote-MCP per-task daemon tokens are handed to agent integrations and
	// cannot attest harness outcomes. Local control-plane credentials stay in the daemon.
	path := middleware.DaemonAuthPathFromContext(r.Context())
	if path != middleware.DaemonAuthPathPAT && path != middleware.DaemonAuthPathJWT {
		writeError(w, http.StatusForbidden, "a control-plane runtime credential is required")
		return
	}
	task, scope, ok := h.requireDaemonTaskAccessWithScope(w, r, chi.URLParam(r, "taskId"))
	if !ok {
		return
	}
	var request struct {
		DispatchedAt string              `json:"dispatched_at"`
		ID           string              `json:"id"`
		Sequence     int                 `json:"sequence"`
		Result       agent.CommandResult `json:"result"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&request) != nil {
		writeError(w, http.StatusBadRequest, "invalid command receipt")
		return
	}
	claim, err := time.Parse(time.RFC3339Nano, request.DispatchedAt)
	if err != nil || !task.DispatchedAt.Valid || !claim.Equal(task.DispatchedAt.Time) || task.Status != "running" || !task.IssueID.Valid {
		writeError(w, http.StatusConflict, "command receipt belongs to an inactive or superseded claim")
		return
	}
	if request.ID == "" || len(request.ID) > 512 || request.Sequence < 0 || request.Result.Command == "" || request.Result.Cwd == "" {
		writeError(w, http.StatusBadRequest, "incomplete command receipt")
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering application is not enabled")
		return
	}
	result, err := h.EngineeringWorker.Call(r.Context(), map[string]any{
		"actor":  map[string]string{"kind": "daemon", "workspaceId": scope.WorkspaceID, "issueId": uuidToString(task.IssueID), "agentId": uuidToString(task.AgentID), "attemptId": uuidToString(task.ID) + ":" + strconv.FormatInt(claim.UnixMicro(), 10)},
		"action": "receipt", "payload": map[string]any{"id": request.ID, "sequence": request.Sequence, "command": redact.Text(request.Result.Command), "cwd": request.Result.Cwd, "status": request.Result.Status, "exit_code": request.Result.ExitCode},
	})
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}
