package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type EngineeringRunContextResponse struct {
	APIVersion  int    `json:"api_version"`
	WorkspaceID string `json:"workspace_id"`
	IssueID     string `json:"issue_id"`
	TaskID      string `json:"task_id"`
	AgentID     string `json:"agent_id"`
	RuntimeID   string `json:"runtime_id"`
	Attempt     int32  `json:"attempt"`
	ClaimID     string `json:"claim_id"`
	AttemptID   string `json:"attempt_id"`
	Status      string `json:"status"`
}

// GetEngineeringRunContext resolves identity from the credential and current
// task rows. Query parameters and client identity headers cannot select a run.
func (h *Handler) GetEngineeringRunContext(w http.ResponseWriter, r *http.Request) {
	credential := middleware.BearerToken(r)
	if r.Header.Get("X-Actor-Source") != "task_token" || !strings.HasPrefix(credential, "mat_") {
		writeError(w, http.StatusForbidden, "a running task credential is required")
		return
	}
	token, err := h.Queries.GetTaskTokenByHash(r.Context(), auth.HashToken(credential))
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid task credential")
		return
	}
	workspaceID := uuidToString(token.WorkspaceID)
	if h.resolveWorkspaceID(r) != workspaceID || r.Header.Get("X-User-ID") != uuidToString(token.UserID) {
		writeError(w, http.StatusForbidden, "task credential identity does not match the request")
		return
	}
	task, err := h.Queries.GetAgentTaskInWorkspace(r.Context(), db.GetAgentTaskInWorkspaceParams{
		ID: token.TaskID, WorkspaceID: token.WorkspaceID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "task not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load task")
		return
	}
	if task.AgentID != token.AgentID {
		writeError(w, http.StatusForbidden, "task credential belongs to another agent")
		return
	}
	if task.Status != "running" || !task.DispatchedAt.Valid || !task.StartedAt.Valid || task.CompletedAt.Valid || !task.RuntimeID.Valid || !task.IssueID.Valid || task.Attempt < 0 {
		writeError(w, http.StatusConflict, "engineering requires an issue-bound running task")
		return
	}
	// Reclaim refreshes dispatched_at without necessarily incrementing attempt.
	// A prior claim's still-unexpired token must not impersonate the new claim.
	if !token.CreatedAt.Valid || token.CreatedAt.Time.Before(task.DispatchedAt.Time) {
		writeError(w, http.StatusForbidden, "task credential belongs to a superseded claim")
		return
	}
	issue, ok := h.loadIssueForUser(w, r, uuidToString(task.IssueID))
	if !ok {
		return
	}
	claimID := strconv.FormatInt(task.DispatchedAt.Time.UnixMicro(), 10)
	taskID := uuidToString(task.ID)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, EngineeringRunContextResponse{
		APIVersion: 1, WorkspaceID: workspaceID, IssueID: uuidToString(issue.ID),
		TaskID: taskID, AgentID: uuidToString(task.AgentID), RuntimeID: uuidToString(task.RuntimeID),
		Attempt: task.Attempt, ClaimID: claimID, AttemptID: taskID + ":" + claimID, Status: task.Status,
	})
}
