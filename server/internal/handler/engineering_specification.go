package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/projectaccess"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type engineeringBusinessComment struct {
	ID       string  `json:"id"`
	UserID   string  `json:"user_id"`
	Content  string  `json:"content"`
	Version  *string `json:"version"`
	Resolved bool    `json:"resolved"`
}
type engineeringBusinessScope struct {
	ProjectID string                       `json:"project_id"`
	Comments  []engineeringBusinessComment `json:"comments"`
}

func specificationCommentVersion(content string) string {
	hash := sha256.Sum256([]byte(content))
	return hex.EncodeToString(hash[:])
}
func (h *Handler) businessNativeScope(ctx context.Context, issue db.Issue, scope engineeringBusinessScope, requireIdle bool) error {
	if scope.Comments == nil || !issue.ProjectID.Valid || scope.ProjectID != uuidToString(issue.ProjectID) || issue.TriageState.Valid {
		return &engineering.Rejection{Message: "business specification project changed", Conflict: true}
	}
	if requireIdle {
		active, err := h.Queries.HasUnfinishedEngineeringIssueTask(ctx, issue.ID)
		if err != nil {
			return err
		}
		if active {
			return &engineering.Rejection{Message: "wait for the business run to finish before reading", Conflict: true}
		}
	}
	seen := map[string]bool{}
	for _, expected := range scope.Comments {
		id, err := util.ParseUUID(expected.ID)
		if err != nil || seen[expected.ID] {
			return fmt.Errorf("invalid native specification comment scope")
		}
		seen[expected.ID] = true
		comment, err := h.Queries.GetCommentInWorkspace(ctx, db.GetCommentInWorkspaceParams{ID: id, WorkspaceID: issue.WorkspaceID})
		if err != nil {
			return err
		}
		if comment.IssueID != issue.ID || comment.DeletedAt.Valid || comment.AuthorType != "member" || uuidToString(comment.AuthorID) != expected.UserID || comment.Content != expected.Content || expected.Version == nil || *expected.Version != specificationCommentVersion(comment.Content) || !expected.Resolved || !comment.ResolvedAt.Valid {
			return &engineering.Rejection{Message: "specification comments require their exact reviewed native versions", Conflict: true}
		}
		attachments, err := h.Queries.ListAttachmentsByComment(ctx, db.ListAttachmentsByCommentParams{CommentID: id, WorkspaceID: issue.WorkspaceID})
		if err != nil {
			return err
		}
		if len(attachments) != 0 {
			return &engineering.Rejection{Message: "versioned specification comment attachments changed", Conflict: true}
		}
	}
	return nil
}
func (h *Handler) loadBusinessNativeScope(ctx context.Context, issue db.Issue) (engineeringBusinessScope, error) {
	var scope engineeringBusinessScope
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "host", "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID)}, "action": "business-scope"})
	if err != nil {
		return scope, err
	}
	if json.Unmarshal(data, &scope) != nil || scope.ProjectID == "" || scope.Comments == nil {
		return scope, fmt.Errorf("invalid business native scope")
	}
	return scope, nil
}
func (h *Handler) AcknowledgeEngineeringSpecification(w http.ResponseWriter, r *http.Request) {
	issue, userID, ok := h.loadHumanEngineeringIssue(w, r)
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering is not enabled")
		return
	}
	var input struct {
		ExpectedVersion int    `json:"expected_version"`
		DraftID         string `json:"draft_id"`
		Hash            string `json:"specification_hash"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.ExpectedVersion < 0 || len(input.Hash) != 64 {
		writeError(w, http.StatusBadRequest, "invalid specification reading acknowledgement")
		return
	}
	if _, ok := parseUUIDOrBadRequest(w, input.DraftID, "draft_id"); !ok {
		return
	}
	scope, err := h.loadBusinessNativeScope(r.Context(), issue)
	if err == nil {
		err = h.businessNativeScope(r.Context(), issue, scope, true)
	}
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	category, err := issuestatus.CategoryWithError(r.Context(), h.Queries, issue.WorkspaceID, issue.Status)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	if category == issuestatus.CategoryClosed {
		writeError(w, http.StatusConflict, "reopen this analysis before reading")
		return
	}
	_, err = h.EngineeringWorker.Call(r.Context(), map[string]any{"actor": map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID)}, "action": "business-read", "payload": input})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	if category != issuestatus.CategoryDone {
		ctx := context.WithValue(r.Context(), wakeupActorKey{}, wakeupActor{kind: "member", id: userID})
		params := db.UpdateIssueParams{ID: issue.ID, Status: pgtype.Text{String: issuestatus.Done, Valid: true}}
		refreshUntouchedNullableIssueParams(&params, issue, nil, false)
		updated, err := h.updateIssueWithStatusGuard(ctx, issue.WorkspaceID, issuestatus.Done, params)
		if err != nil {
			if !writeEngineeringCompletionError(w, err) {
				writeError(w, http.StatusConflict, err.Error())
			}
			return
		}
		h.publishIssueSnapshots(ctx, []db.Issue{updated}, "member", userID)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"acknowledged": true})
}
func (h *Handler) CreateEngineeringSpecificationComment(w http.ResponseWriter, r *http.Request) {
	issue, userID, ok := h.loadHumanEngineeringIssue(w, r)
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering is not enabled")
		return
	}
	category, err := issuestatus.CategoryWithError(r.Context(), h.Queries, issue.WorkspaceID, issue.Status)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	if category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed || issue.TriageState.Valid {
		writeError(w, http.StatusConflict, "specification feedback requires an open accepted analysis")
		return
	}
	var input struct {
		RequestID   string  `json:"request_id"`
		DraftID     string  `json:"draft_id"`
		Hash        string  `json:"specification_hash"`
		Content     string  `json:"content"`
		AnchorType  string  `json:"anchor_type,omitempty"`
		QuotedText  *string `json:"quoted_text,omitempty"`
		StartOffset *int    `json:"start_offset,omitempty"`
		EndOffset   *int    `json:"end_offset,omitempty"`
		Intent      string  `json:"intent,omitempty"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid specification feedback")
		return
	}
	input.Content = strings.TrimSpace(sanitizeNullBytes(input.Content))
	if input.Content == "" {
		writeError(w, http.StatusBadRequest, "specification feedback is required")
		return
	}
	if input.QuotedText != nil {
		quote := sanitizeNullBytes(*input.QuotedText)
		input.QuotedText = &quote
	}
	if _, ok := parseUUIDOrBadRequest(w, input.RequestID, "request_id"); !ok {
		return
	}
	if _, ok := parseUUIDOrBadRequest(w, input.DraftID, "draft_id"); !ok {
		return
	}
	scope, err := h.loadBusinessNativeScope(r.Context(), issue)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	if scope.ProjectID != uuidToString(issue.ProjectID) || !issue.ProjectID.Valid {
		writeError(w, http.StatusConflict, "business specification project changed")
		return
	}
	result, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"actor": map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID)}, "action": "business-comment", "payload": input})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	var prepared struct {
		CommentID string `json:"comment_id"`
	}
	if json.Unmarshal(result, &prepared) != nil {
		writeError(w, http.StatusServiceUnavailable, "invalid specification comment intent")
		return
	}
	if err = h.publishSpecificationComment(r.Context(), issue, prepared.CommentID, false); err != nil {
		engineeringControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"submitted": true, "comment_id": prepared.CommentID})
}
func (h *Handler) publishSpecificationComment(ctx context.Context, issue db.Issue, commentID string, resolve bool) error {
	id, err := util.ParseUUID(commentID)
	if err != nil {
		return err
	}
	actor := map[string]string{"kind": "host", "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID)}
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": actor, "action": "business-comment-intent", "payload": map[string]string{"comment_id": commentID}})
	if err != nil {
		return err
	}
	var intent struct {
		ProjectID  string `json:"project_id"`
		UserID     string `json:"user_id"`
		Content    string `json:"content"`
		ReviewerID string `json:"reviewer_id"`
		Reviewed   bool   `json:"reviewed"`
	}
	if json.Unmarshal(data, &intent) != nil || intent.Content == "" || !issue.ProjectID.Valid || intent.ProjectID != uuidToString(issue.ProjectID) || issue.TriageState.Valid {
		return &engineering.Rejection{Message: "specification comment native scope changed", Conflict: true}
	}
	userID, err := util.ParseUUID(intent.UserID)
	if err != nil {
		return err
	}
	member, err := h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: userID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return err
	}
	access, err := projectaccess.ForMember(ctx, h.Queries, issue.WorkspaceID, userID, member.Role)
	if err != nil {
		return err
	}
	if !access.CanSeeProject(issue.ProjectID) {
		return fmt.Errorf("specification comment project is no longer visible")
	}
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, issue.WorkspaceID, issue.Status)
	if err != nil {
		return err
	}
	if category == issuestatus.CategoryClosed || category == issuestatus.CategoryDone {
		return &engineering.Rejection{Message: "reopen the analysis before publishing specification feedback", Conflict: true}
	}
	comment, err := h.Queries.GetCommentInWorkspace(ctx, db.GetCommentInWorkspaceParams{ID: id, WorkspaceID: issue.WorkspaceID})
	if errors.Is(err, pgx.ErrNoRows) && !resolve {
		writeCtx := context.WithValue(ctx, wakeupActorKey{}, wakeupActor{kind: "member", id: intent.UserID})
		tx, err := h.beginWakeupWrite(writeCtx)
		if err != nil {
			return err
		}
		defer tx.Rollback(writeCtx)
		created, createErr := h.Queries.WithTx(tx).CreateComment(writeCtx, db.CreateCommentParams{ID: id, IssueID: issue.ID, WorkspaceID: issue.WorkspaceID, AuthorType: "member", AuthorID: userID, Content: intent.Content, Type: "comment"})
		if createErr == nil {
			if err = tx.Commit(writeCtx); err != nil {
				return err
			}
			comment = created.Comment()
			h.publish(protocol.EventCommentCreated, uuidToString(issue.WorkspaceID), "member", intent.UserID, map[string]any{"comment": commentToResponse(comment, nil, nil), "issue_revision": created.IssueRevision})
		} else {
			_ = tx.Rollback(writeCtx)
			comment, err = h.Queries.GetCommentInWorkspace(ctx, db.GetCommentInWorkspaceParams{ID: id, WorkspaceID: issue.WorkspaceID})
			if err != nil {
				return createErr
			}
		}
	} else if err != nil {
		return err
	}
	if comment.IssueID != issue.ID || comment.DeletedAt.Valid || comment.AuthorType != "member" || comment.AuthorID != userID || comment.Content != intent.Content {
		return &engineering.Rejection{Message: "native specification comment differs from its frozen intent", Conflict: true}
	}
	version := specificationCommentVersion(comment.Content)
	action := "business-comment-ack"
	if resolve {
		if !intent.Reviewed {
			return &engineering.Rejection{Message: "specification comment has not passed independent review", Conflict: true}
		}
		reviewerID, err := util.ParseUUID(intent.ReviewerID)
		if err != nil {
			return err
		}
		comment, err = h.Queries.ResolveComment(ctx, db.ResolveCommentParams{ID: id, ResolvedByType: pgtype.Text{String: "agent", Valid: true}, ResolvedByID: reviewerID})
		if err != nil {
			return err
		}
		action = "business-comment-resolved"
		h.publish(protocol.EventCommentResolved, uuidToString(issue.WorkspaceID), "agent", intent.ReviewerID, map[string]any{"comment": commentToResponse(comment, nil, nil)})
	}
	_, err = h.EngineeringWorker.Call(ctx, map[string]any{"actor": actor, "action": action, "payload": map[string]string{"comment_id": commentID, "version": version}})
	return err
}
func (h *Handler) dispatchSpecificationComment(ctx context.Context, item engineeringContinuation) error {
	workspaceID, err := util.ParseUUID(item.WorkspaceID)
	if err != nil {
		return err
	}
	issueID, err := util.ParseUUID(item.IssueID)
	if err != nil {
		return err
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	return h.publishSpecificationComment(ctx, issue, item.CommentID, item.Reason == "business_comment_resolve")
}
func (h *Handler) protectSpecificationComment(w http.ResponseWriter, r *http.Request, comment db.Comment) bool {
	if h.EngineeringWorker == nil {
		return false
	}
	data, err := h.EngineeringWorker.Call(r.Context(), map[string]any{"actor": map[string]string{"kind": "host", "workspaceId": uuidToString(comment.WorkspaceID), "issueId": uuidToString(comment.IssueID)}, "action": "business-comment-protected", "payload": map[string]string{"comment_id": uuidToString(comment.ID)}})
	var result struct {
		Protected *bool `json:"protected"`
	}
	if err != nil || json.Unmarshal(data, &result) != nil || result.Protected == nil {
		writeError(w, http.StatusServiceUnavailable, "specification comment ownership is unavailable")
		return true
	}
	if *result.Protected {
		writeError(w, http.StatusConflict, "versioned specification comments are immutable; submit feedback on the current specification")
		return true
	}
	return false
}
