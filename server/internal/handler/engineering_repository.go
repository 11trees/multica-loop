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

func (h *Handler) BindEngineeringRepository(w http.ResponseWriter, r *http.Request) {
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
		DispatchedAt string `json:"dispatched_at"`
		WorkDir      string `json:"work_dir"`
		Mode         string `json:"mode"`
		Overlays     []struct {
			Path string `json:"path"`
			Hash string `json:"hash"`
		} `json:"overlays"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&request) != nil {
		writeError(w, http.StatusBadRequest, "invalid repository binding")
		return
	}
	claim, err := time.Parse(time.RFC3339Nano, request.DispatchedAt)
	if err != nil || !task.DispatchedAt.Valid || !claim.Equal(task.DispatchedAt.Time) || task.Status != "running" || !task.IssueID.Valid {
		writeError(w, http.StatusConflict, "repository binding belongs to an inactive or superseded claim")
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering application is not enabled")
		return
	}
	if request.Overlays == nil {
		request.Overlays = make([]struct {
			Path string `json:"path"`
			Hash string `json:"hash"`
		}, 0)
	}
	issue, err := h.Queries.GetIssueInWorkspace(r.Context(), db.GetIssueInWorkspaceParams{ID: task.IssueID, WorkspaceID: parseUUID(scope.WorkspaceID)})
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "native engineering project lookup is unavailable")
		return
	}
	actor := map[string]string{"kind": "daemon", "workspaceId": scope.WorkspaceID, "issueId": uuidToString(task.IssueID), "agentId": uuidToString(task.AgentID), "attemptId": uuidToString(task.ID) + ":" + strconv.FormatInt(claim.UnixMicro(), 10)}
	if issue.ProjectID.Valid {
		actor["projectId"] = uuidToString(issue.ProjectID)
	}
	result, err := h.EngineeringWorker.Call(r.Context(), map[string]any{
		"actor":  actor,
		"action": "bind", "payload": map[string]any{"work_dir": request.WorkDir, "mode": request.Mode, "overlays": request.Overlays},
	})
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}
