package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type specificationFixture struct {
	projectID, commentID, reviewerID, content string
	published, reviewed, resolved, read       bool
	readCalls                                 int
}

func (f *specificationFixture) scope() map[string]any {
	comments := []map[string]any{}
	if f.published {
		comments = append(comments, map[string]any{"id": f.commentID, "user_id": testUserID, "content": f.content, "version": specificationCommentVersion(f.content), "resolved": f.resolved})
	}
	return map[string]any{"project_id": f.projectID, "comments": comments}
}
func (f *specificationFixture) Call(_ context.Context, input any) (json.RawMessage, error) {
	value := input.(map[string]any)
	var result any
	switch value["action"] {
	case "parent-scope":
		result = map[string]bool{"managed": false}
	case "business-scope":
		result = f.scope()
	case "business-comment":
		result = map[string]string{"comment_id": f.commentID}
	case "business-comment-intent":
		result = map[string]any{"project_id": f.projectID, "user_id": testUserID, "content": f.content, "reviewed": f.reviewed, "reviewer_id": f.reviewerID}
	case "business-comment-ack":
		f.published = true
		result = map[string]bool{"acknowledged": true}
	case "business-comment-resolved":
		f.resolved = true
		result = map[string]bool{"acknowledged": true}
	case "business-comment-protected":
		result = map[string]bool{"protected": true}
	case "business-read":
		f.read = true
		f.readCalls++
		result = map[string]bool{"acknowledged": true}
	case "completion":
		result = map[string]any{"configured": true, "allowed": f.read, "business_scope": f.scope()}
	default:
		return nil, fmt.Errorf("unexpected specification operation: %v", value["action"])
	}
	return json.Marshal(result)
}

func TestEngineeringSpecificationPublishesOneNativeCommentResolvesAfterReviewAndClosesOnlyAfterReading(t *testing.T) {
	ctx := context.Background()
	runtimeID := dbfx.Runtime(t, "Specification reviewer runtime")
	reviewerID := dbfx.Agent(t, "Specification reviewer", runtimeID)
	projectID := dbfx.Project(t, "Specification project")
	issueID := dbfx.Issue(t, "Reviewed specification", testutil.Cols{"project_id": projectID, "status": "todo"})
	f := &specificationFixture{projectID: projectID, commentID: uuidToString(dbid.NewV7()), reviewerID: reviewerID, content: "> selected item\n\nClarify item identity"}
	h := *testHandler
	h.EngineeringWorker = f
	request := func(body any) *http.Request {
		return withURLParam(newRequest(http.MethodPost, "/api/issues/"+issueID+"/engineering/business-analysis", body), "id", issueID)
	}
	commentInput := map[string]any{"request_id": uuidToString(dbid.NewV7()), "draft_id": uuidToString(dbid.NewV7()), "specification_hash": strings.Repeat("a", 64), "content": "Clarify item identity", "anchor_type": "selection", "quoted_text": "selected item"}
	for range 2 {
		testutil.Call(t, h.CreateEngineeringSpecificationComment, request(commentInput)).Want(http.StatusOK)
	}
	var count int
	dbfx.QueryRow(t, `SELECT count(*) FROM comment WHERE id=$1 AND issue_id=$2`, f.commentID, issueID).Scan(&count)
	if count != 1 {
		t.Fatal("specification retry duplicated the native comment")
	}
	comment, err := h.Queries.GetCommentInWorkspace(ctx, db.GetCommentInWorkspaceParams{ID: parseUUID(f.commentID), WorkspaceID: parseUUID(testWorkspaceID)})
	if err != nil {
		t.Fatal(err)
	}
	if comment.AuthorType != "member" || uuidToString(comment.AuthorID) != testUserID || comment.Content != f.content {
		t.Fatal("native comment lost its human scope")
	}
	reading := map[string]any{"expected_version": 8, "draft_id": commentInput["draft_id"], "specification_hash": strings.Repeat("a", 64)}
	testutil.Call(t, h.AcknowledgeEngineeringSpecification, request(reading)).Want(http.StatusConflict)
	if f.readCalls != 0 {
		t.Fatal("unreviewed native comment reached reading acknowledgement")
	}
	f.reviewed = true
	issue, err := h.Queries.GetIssue(ctx, parseUUID(issueID))
	if err != nil {
		t.Fatal(err)
	}
	if err = h.publishSpecificationComment(ctx, issue, f.commentID, true); err != nil {
		t.Fatal(err)
	}
	comment, err = h.Queries.GetComment(ctx, parseUUID(f.commentID))
	if err != nil {
		t.Fatal(err)
	}
	if !comment.ResolvedAt.Valid || comment.ResolvedByType.String != "agent" || uuidToString(comment.ResolvedByID) != reviewerID || !f.resolved {
		t.Fatal("reviewed specification comment was not resolved by its native role")
	}
	update := withURLParam(newRequest(http.MethodPut, "/api/comments/"+f.commentID, map[string]any{"content": "Rewrite old feedback"}), "commentId", f.commentID)
	testutil.Call(t, h.UpdateComment, update).Want(http.StatusConflict)
	remove := withURLParam(newRequest(http.MethodDelete, "/api/comments/"+f.commentID, nil), "commentId", f.commentID)
	testutil.Call(t, h.DeleteComment, remove).Want(http.StatusConflict)
	testutil.Call(t, h.AcknowledgeEngineeringSpecification, request(reading)).Want(http.StatusOK)
	issue, err = h.Queries.GetIssue(ctx, parseUUID(issueID))
	if err != nil {
		t.Fatal(err)
	}
	if issue.Status != "done" {
		t.Fatalf("analysis did not close through its native reading gate: %s", issue.Status)
	}
	testutil.Call(t, h.AcknowledgeEngineeringSpecification, request(reading)).Want(http.StatusOK)
}

func TestEngineeringSpecificationReadingRechecksNativeProjectCommentsAndUnfinishedRuns(t *testing.T) {
	for _, failure := range []string{"project", "comment", "running"} {
		t.Run(failure, func(t *testing.T) {
			projectID := dbfx.Project(t, "Specification reading scope")
			issueID := dbfx.Issue(t, "Specification reading", testutil.Cols{"project_id": projectID, "status": "todo"})
			runtimeID := dbfx.Runtime(t, "Specification scope runtime")
			reviewerID := dbfx.Agent(t, "Specification scope reviewer", runtimeID)
			f := &specificationFixture{projectID: projectID, commentID: uuidToString(dbid.NewV7()), reviewerID: reviewerID, content: "Clarify the selected item", reviewed: true}
			h := *testHandler
			h.EngineeringWorker = f
			issue, err := h.Queries.GetIssue(context.Background(), parseUUID(issueID))
			if err != nil {
				t.Fatal(err)
			}
			if err = h.publishSpecificationComment(context.Background(), issue, f.commentID, false); err != nil {
				t.Fatal(err)
			}
			if err = h.publishSpecificationComment(context.Background(), issue, f.commentID, true); err != nil {
				t.Fatal(err)
			}
			switch failure {
			case "project":
				dbfx.Exec(t, `UPDATE issue SET project_id=NULL WHERE id=$1`, issueID)
			case "comment":
				dbfx.Exec(t, `UPDATE comment SET content='Altered after independent review' WHERE id=$1`, f.commentID)
			case "running":
				taskID := dbfx.Task(t, reviewerID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "running"})
				t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id=$1`, taskID) })
			}
			r := withURLParam(newRequest(http.MethodPost, "/api/issues/"+issueID+"/engineering/business-analysis/acknowledge", map[string]any{"expected_version": 8, "draft_id": uuidToString(dbid.NewV7()), "specification_hash": strings.Repeat("a", 64)}), "id", issueID)
			testutil.Call(t, h.AcknowledgeEngineeringSpecification, r).Want(http.StatusConflict)
			if f.readCalls != 0 {
				t.Fatal("invalid native scope reached the reading mutation")
			}
		})
	}
}
