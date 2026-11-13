package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/projectaccess"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (h *Handler) BeginEngineeringFeedback(w http.ResponseWriter, r *http.Request) {
	parent, userID, ok := h.loadHumanEngineeringIssue(w, r)
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering is not enabled")
		return
	}
	var payload struct {
		RequestID           string   `json:"request_id"`
		ExpectedRevision    int      `json:"expected_revision"`
		ExpectedSequence    int      `json:"expected_sequence"`
		ExpectedBatchNumber int      `json:"expected_batch_number"`
		AgentID             string   `json:"agent_id"`
		VerifierID          string   `json:"verifier_id"`
		CommentIDs          []string `json:"comment_ids"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil || payload.ExpectedRevision < 1 || payload.ExpectedSequence < 0 || payload.ExpectedBatchNumber < 0 || len(payload.CommentIDs) < 1 || len(payload.CommentIDs) > 100 {
		writeError(w, http.StatusBadRequest, "invalid feedback capture")
		return
	}
	if _, ok := parseUUIDOrBadRequest(w, payload.RequestID, "request_id"); !ok {
		return
	}
	category, err := issuestatus.CategoryWithError(r.Context(), h.Queries, parent.WorkspaceID, parent.Status)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	if parent.TriageState.Valid || category == issuestatus.CategoryClosed {
		writeError(w, http.StatusConflict, "reopen and accept the requirement before feedback")
		return
	}
	resources := make([]map[string]string, 0, 2)
	agentIDs := make([]string, 0, 2)
	for _, id := range []string{payload.AgentID, payload.VerifierID} {
		agent, ok := h.loadAgentForUser(w, r, id)
		if !ok {
			return
		}
		if !h.canInvokeAgent(r.Context(), agent, "member", userID, userID, uuidToString(parent.WorkspaceID)) {
			writeError(w, http.StatusForbidden, "feedback role is not invocable")
			return
		}
		mapping, err := h.engineeringExecutionResources(r.Context(), parent, agent)
		if err != nil {
			engineeringControlError(w, err)
			return
		}
		resources = append(resources, mapping...)
		agentIDs = append(agentIDs, uuidToString(agent.ID))
	}
	units, err := h.loadReviewUnits(r.Context(), parent, false)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	comments := make([]map[string]string, 0, len(payload.CommentIDs))
	seen := make(map[string]bool)
	for _, raw := range payload.CommentIDs {
		id, ok := parseUUIDOrBadRequest(w, raw, "comment_id")
		if !ok {
			return
		}
		commentID := uuidToString(id)
		if seen[commentID] {
			writeError(w, http.StatusBadRequest, "feedback comments must be unique")
			return
		}
		seen[commentID] = true
		comment, err := h.Queries.GetCommentInWorkspace(r.Context(), db.GetCommentInWorkspaceParams{ID: id, WorkspaceID: parent.WorkspaceID})
		if err != nil || comment.IssueID != parent.ID || comment.DeletedAt.Valid || comment.Type != "comment" {
			writeError(w, http.StatusNotFound, "feedback comment is not available in this requirement")
			return
		}
		attachments, err := h.Queries.ListAttachmentsByComment(r.Context(), db.ListAttachmentsByCommentParams{CommentID: id, WorkspaceID: parent.WorkspaceID})
		if err != nil {
			engineeringControlError(w, err)
			return
		}
		sort.Slice(attachments, func(i, j int) bool { return uuidToString(attachments[i].ID) < uuidToString(attachments[j].ID) })
		refs := make([]map[string]any, 0, len(attachments))
		for _, attachment := range attachments {
			refs = append(refs, map[string]any{"id": uuidToString(attachment.ID), "filename": attachment.Filename, "content_type": attachment.ContentType, "size_bytes": attachment.SizeBytes})
		}
		content := comment.Content
		if len(refs) > 0 {
			body, _ := json.Marshal(map[string]any{"text": comment.Content, "attachments": refs})
			content = string(body)
		}
		if strings.TrimSpace(content) == "" {
			writeError(w, http.StatusBadRequest, "feedback comment is empty")
			return
		}
		snapshot, _ := json.Marshal(map[string]any{"id": commentID, "revision": comment.Revision, "content": content, "author_type": comment.AuthorType, "author_id": uuidToString(comment.AuthorID), "updated_at": comment.UpdatedAt})
		fingerprint := sha256.Sum256(snapshot)
		comments = append(comments, map[string]string{"id": uuidToString(comment.ID), "version": hex.EncodeToString(fingerprint[:]), "content": content, "authorId": comment.AuthorType + ":" + uuidToString(comment.AuthorID), "sourceRef": "COMMENT:" + uuidToString(comment.ID) + ":r" + strconv.FormatInt(comment.Revision, 10)})
	}
	ids := make([]string, len(units))
	for i, unit := range units {
		ids[i] = unit.IssueID
	}
	result, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"actor": map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(parent.WorkspaceID), "issueId": uuidToString(parent.ID)}, "action": "begin-feedback", "payload": map[string]any{"request_id": payload.RequestID, "expected_revision": payload.ExpectedRevision, "expected_sequence": payload.ExpectedSequence, "expected_batch_number": payload.ExpectedBatchNumber, "agent_id": agentIDs[0], "verifier_id": agentIDs[1], "comments": comments, "restore_done": category == issuestatus.CategoryDone, "execution_resources": resources, "native_unit_ids": ids}})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	var admission struct {
		Configured *bool `json:"configured"`
		Reopen     *bool `json:"reopen_required"`
	}
	if json.Unmarshal(result, &admission) != nil || admission.Configured == nil || !*admission.Configured || admission.Reopen == nil {
		writeError(w, http.StatusServiceUnavailable, "invalid feedback admission")
		return
	}
	if *admission.Reopen && category == issuestatus.CategoryDone {
		params := db.UpdateIssueParams{ID: parent.ID, Status: pgtype.Text{String: issuestatus.Todo, Valid: true}}
		refreshUntouchedNullableIssueParams(&params, parent, nil, false)
		ctx := context.WithValue(r.Context(), wakeupActorKey{}, wakeupActor{kind: "member", id: userID})
		updated, err := h.updateIssueWithStatusGuard(ctx, parent.WorkspaceID, issuestatus.Todo, params)
		if err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		h.publishIssueSnapshots(ctx, []db.Issue{updated}, "member", userID)
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) CancelEngineeringFeedback(w http.ResponseWriter, r *http.Request) {
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
		Reason          string `json:"reason"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil || payload.ExpectedVersion < 0 || strings.TrimSpace(payload.Reason) == "" {
		writeError(w, http.StatusBadRequest, "invalid feedback cancellation")
		return
	}
	if _, ok := parseUUIDOrBadRequest(w, payload.BatchID, "batch_id"); !ok {
		return
	}
	if _, err := h.loadReviewUnits(r.Context(), parent, false); err != nil {
		engineeringControlError(w, err)
		return
	}
	result, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"actor": map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(parent.WorkspaceID), "issueId": uuidToString(parent.ID)}, "action": "cancel-feedback", "payload": payload})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) restoreEngineeringFeedback(ctx context.Context, item engineeringContinuation) error {
	workspaceID, err := util.ParseUUID(item.WorkspaceID)
	if err != nil {
		return err
	}
	issueID, err := util.ParseUUID(item.IssueID)
	if err != nil {
		return err
	}
	userID, err := util.ParseUUID(item.UserID)
	if err != nil {
		return err
	}
	parent, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	member, err := h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: userID, WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	access, err := projectaccess.ForMember(ctx, h.Queries, workspaceID, userID, member.Role)
	if err != nil {
		return err
	}
	if !access.CanSeeProject(parent.ProjectID) {
		return fmt.Errorf("feedback requirement is no longer visible")
	}
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, workspaceID, parent.Status)
	if err != nil {
		return err
	}
	if parent.TriageState.Valid || category == issuestatus.CategoryClosed {
		return nil
	}
	if _, err := h.loadReviewUnits(ctx, parent, false); err != nil {
		return err
	}
	params := db.UpdateIssueParams{ID: parent.ID, Status: pgtype.Text{String: issuestatus.Done, Valid: true}}
	refreshUntouchedNullableIssueParams(&params, parent, nil, false)
	if err := h.requireEngineeringCompletion(ctx, workspaceID, params); err != nil {
		return err
	}
	if category != issuestatus.CategoryDone {
		actorCtx := context.WithValue(ctx, wakeupActorKey{}, wakeupActor{kind: "member", id: item.UserID})
		updated, err := h.updateIssueWithStatusGuard(actorCtx, workspaceID, issuestatus.Done, params)
		if err != nil {
			return err
		}
		h.publishIssueSnapshots(actorCtx, []db.Issue{updated}, "member", item.UserID)
	}
	_, err = h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "host", "workspaceId": item.WorkspaceID, "issueId": item.IssueID}, "action": "feedback-restored", "payload": map[string]any{"batch_id": item.FeedbackBatchID, "expected_version": item.ExpectedSequence}})
	return err
}
