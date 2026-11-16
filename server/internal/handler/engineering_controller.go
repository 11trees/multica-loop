package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering/ownership"
	"github.com/multica-ai/multica/server/internal/middleware"
)

func (h *Handler) RecordEngineeringController(w http.ResponseWriter, r *http.Request) {
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
		writeError(w, http.StatusServiceUnavailable, "engineering ownership is not enabled")
		return
	}
	var input struct {
		Operation         string `json:"operation"`
		ControllerID      string `json:"controller_id"`
		AllocationID      string `json:"allocation_id,omitempty"`
		Claim             string `json:"dispatched_at"`
		Provider          string `json:"provider,omitempty"`
		HostID            string `json:"host_id"`
		PID               int64  `json:"pid,omitempty"`
		Marker            string `json:"marker,omitempty"`
		GroupID           int64  `json:"group_id,omitempty"`
		WorkspacePath     string `json:"workspace_path,omitempty"`
		Mode              string `json:"mode,omitempty"`
		Confirmed         *bool  `json:"exit_confirmed,omitempty"`
		NoProviderStarted *bool  `json:"no_provider_started,omitempty"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil {
		writeError(w, http.StatusBadRequest, "invalid execution controller record")
		return
	}
	id, ok := parseUUIDOrBadRequest(w, input.ControllerID, "controller_id")
	if !ok {
		return
	}
	var allocation pgtype.UUID
	if input.AllocationID != "" {
		allocation, ok = parseUUIDOrBadRequest(w, input.AllocationID, "allocation_id")
		if !ok {
			return
		}
	}
	claim, err := time.Parse(time.RFC3339Nano, input.Claim)
	if err != nil || !task.DispatchedAt.Valid || !claim.Equal(task.DispatchedAt.Time) || !task.RuntimeID.Valid {
		writeError(w, http.StatusConflict, "execution controller belongs to a stale native claim")
		return
	}
	admission := input.Operation == "begin" || input.Operation == "workspace" || input.Operation == "process-reserve"
	if admission && !h.requireEngineeringExecutionAdmission(w, r, task.IssueID, task.ID, scope.WorkspaceID) {
		return
	}
	result, err := (ownership.Store{Queries: h.Queries, Transactions: h.TxStarter}).RecordController(r.Context(), task, parseUUID(scope.WorkspaceID), ownership.ControllerRequest{ControllerID: id, AllocationID: allocation, Operation: input.Operation, Provider: input.Provider, HostID: input.HostID, PID: input.PID, Marker: input.Marker, GroupID: input.GroupID, WorkspacePath: input.WorkspacePath, Mode: input.Mode, Confirmed: input.Confirmed, NoProviderStarted: input.NoProviderStarted})
	if err != nil {
		if ownership.IsConflict(err) {
			writeError(w, http.StatusConflict, err.Error())
		} else {
			writeError(w, http.StatusServiceUnavailable, "execution ownership could not be persisted")
		}
		return
	}
	// The real PID is durable before protocol admission can reject its launch.
	if input.Operation == "process-bind" && !h.requireEngineeringExecutionAdmission(w, r, task.IssueID, task.ID, scope.WorkspaceID) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) requireEngineeringExecutionAdmission(w http.ResponseWriter, r *http.Request, issueID, taskID pgtype.UUID, workspace string) bool {
	if !issueID.Valid {
		return true
	}
	data, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"action": "execution-permission", "actor": map[string]string{"kind": "host", "workspaceId": workspace, "issueId": uuidToString(issueID)}, "payload": map[string]string{"task_id": uuidToString(taskID)}})
	var permission struct {
		Allowed *bool `json:"allowed"`
	}
	if err != nil || json.Unmarshal(data, &permission) != nil || permission.Allowed == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering execution admission is unavailable")
		return false
	}
	if !*permission.Allowed {
		writeError(w, http.StatusConflict, "execution surrendered to Admin; preserve the checkpoint and end execution")
		return false
	}
	return true
}
