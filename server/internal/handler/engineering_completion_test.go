package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestEngineeringCompletionWriteBoundaries(t *testing.T) {
	for _, path := range []string{"single", "description", "batch"} {
		for _, tc := range []struct {
			name     string
			response json.RawMessage
			err      error
			want     int
		}{
			{"unconfigured", json.RawMessage(`{"configured":false,"allowed":true}`), nil, http.StatusOK},
			{"verified", json.RawMessage(`{"configured":true,"allowed":true}`), nil, http.StatusOK},
			{"pending", nil, &engineering.Rejection{Message: "Complete independent verification"}, http.StatusConflict},
			{"denied", json.RawMessage(`{"configured":true,"allowed":false}`), nil, http.StatusConflict},
			{"unavailable", nil, errors.New("worker stopped"), http.StatusServiceUnavailable},
			{"malformed", json.RawMessage(`{"allowed":true}`), nil, http.StatusServiceUnavailable},
		} {
			t.Run(path+"/"+tc.name, func(t *testing.T) {
				issueID := dbfx.Issue(t, "Engineering completion boundary", testutil.Cols{"status": "todo"})
				recorder := &engineeringRecorder{response: tc.response, err: tc.err}
				h := *testHandler
				h.EngineeringWorker = recorder
				updates := map[string]any{"status": "done"}
				if path == "description" {
					updates["description"] = "Must not persist when completion is rejected"
				}
				if path == "batch" {
					testutil.Call(t, h.BatchUpdateIssues, newRequest(http.MethodPost, "/api/issues/batch-update", map[string]any{"issue_ids": []string{issueID}, "updates": updates})).Want(tc.want)
				} else {
					testutil.Call(t, h.UpdateIssue, withURLParam(newRequest(http.MethodPut, "/api/issues/"+issueID, updates), "id", issueID)).Want(tc.want)
				}
				current, err := h.Queries.GetIssue(context.Background(), parseUUID(issueID))
				if err != nil {
					t.Fatal(err)
				}
				wantStatus := "todo"
				if tc.want == http.StatusOK {
					wantStatus = "done"
				}
				if current.Status != wantStatus || tc.want != http.StatusOK && current.Description.Valid {
					t.Fatalf("rejected write changed issue: status=%s description=%+v", current.Status, current.Description)
				}
				if len(recorder.inputs) == 0 {
					t.Fatal("completion did not reach host gate")
				}
				input := recorder.inputs[0]
				actor := input["actor"].(map[string]any)
				if input["action"] != "completion" || actor["kind"] != "host" || actor["workspaceId"] != testWorkspaceID || actor["issueId"] != issueID {
					t.Fatalf("wrong trusted completion scope: %+v", input)
				}
			})
		}
	}
}

func TestEngineeringCompletionCustomStatusAndCancellation(t *testing.T) {
	custom := "engineering_done_" + uuidToString(dbid.NewV7())[24:]
	dbfx.Insert(t, "issue_status", testutil.Cols{"workspace_id": testWorkspaceID, "key": custom, "name": "Verified delivery", "category": "done", "color": "#123456", "position": 900})
	for _, target := range []string{custom, "cancelled", "in_review"} {
		t.Run(target, func(t *testing.T) {
			issueID := dbfx.Issue(t, "Engineering terminal status", testutil.Cols{"status": "todo"})
			recorder := &engineeringRecorder{err: &engineering.Rejection{Message: "Verification pending"}}
			h := *testHandler
			h.EngineeringWorker = recorder
			want := http.StatusOK
			if target == custom {
				want = http.StatusConflict
			}
			testutil.Call(t, h.UpdateIssue, withURLParam(newRequest(http.MethodPut, "/api/issues/"+issueID, map[string]any{"status": target}), "id", issueID)).Want(want)
			if (len(recorder.inputs) > 0) != (target == custom) {
				t.Fatal("gate did not follow lifecycle category")
			}
		})
	}
}

func TestEngineeringCompletionBatchRejectsBeforeAnyItem(t *testing.T) {
	first := dbfx.Issue(t, "Ungated batch item", testutil.Cols{"status": "todo"})
	blocked := dbfx.Issue(t, "Blocked batch item", testutil.Cols{"status": "todo"})
	h := *testHandler
	h.EngineeringWorker = completionBatchWorker{blocked: blocked}
	testutil.Call(t, h.BatchUpdateIssues, newRequest(http.MethodPost, "/api/issues/batch-update", map[string]any{"issue_ids": []string{first, blocked}, "updates": map[string]any{"status": "done"}})).Want(http.StatusConflict)
	for _, id := range []string{first, blocked} {
		current, err := h.Queries.GetIssue(context.Background(), parseUUID(id))
		if err != nil {
			t.Fatal(err)
		}
		if current.Status != "todo" {
			t.Fatalf("batch preflight changed %s to %s", id, current.Status)
		}
	}
}

func TestEngineeringCompletionAgentCannotBypass(t *testing.T) {
	_, token, _, _, issueID := engineeringRunFixture(t)
	h := *testHandler
	h.EngineeringWorker = &engineeringRecorder{err: &engineering.Rejection{Message: "Verification pending"}}
	r := withURLParam(httptest.NewRequest(http.MethodPut, "/api/issues/"+issueID, strings.NewReader(`{"status":"done","suppress_run":true}`)), "id", issueID)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Workspace-ID", testWorkspaceID)
	handler := middleware.Auth(h.Queries, nil, nil, nil)(middleware.RequireWorkspaceMember(h.Queries)(http.HandlerFunc(h.UpdateIssue)))
	testutil.Call(t, handler.ServeHTTP, r).Want(http.StatusConflict)
	current, err := h.Queries.GetIssue(context.Background(), parseUUID(issueID))
	if err != nil {
		t.Fatal(err)
	}
	if current.Status == "done" {
		t.Fatal("agent bypassed synchronous completion gate")
	}
}

func TestEngineeringCompletionWorkflowRemapsRollback(t *testing.T) {
	for _, entry := range []string{"switch", "edit"} {
		t.Run(entry, func(t *testing.T) {
			projectID := createWorkflowTestProject(t, "Engineering workflow "+entry)
			middle := []string{}
			if entry == "edit" {
				middle = append(middle, "in_review")
			}
			wf := createTestWorkflow(t, "Engineering workflow "+workflowTestSuffix(), middle...)
			if entry == "edit" {
				setProjectWorkflow(t, projectID, map[string]any{"workflow_id": wf.ID}).Want(http.StatusOK)
			}
			issueID := dbfx.Issue(t, "Engineering remap", testutil.Cols{"project_id": projectID, "status": "in_review"})
			h := *testHandler
			h.EngineeringWorker = &engineeringRecorder{err: &engineering.Rejection{Message: "Verification pending"}}
			if entry == "switch" {
				r := withURLParam(workflowRequest(http.MethodPost, "/api/projects/"+projectID+"/workflow", map[string]any{"workflow_id": wf.ID, "status_mapping": map[string]string{"in_review": "done"}}), "id", projectID)
				testutil.Call(t, h.SetProjectWorkflow, r).Want(http.StatusConflict)
			} else {
				r := withURLParam(workflowRequest(http.MethodPut, "/api/issue-workflows/"+wf.ID, map[string]any{"steps": statusSteps("backlog", "done", "blocked"), "status_mapping": map[string]string{"in_review": "done"}}), "id", wf.ID)
				testutil.Call(t, h.UpdateIssueWorkflow, r).Want(http.StatusConflict)
			}
			current, err := h.Queries.GetIssue(context.Background(), parseUUID(issueID))
			if err != nil {
				t.Fatal(err)
			}
			if current.Status != "in_review" {
				t.Fatal("workflow mapping committed a blocked completion")
			}
		})
	}
}

func TestEngineeringCompletionPRAutomation(t *testing.T) {
	secret := "engineering-pr-completion-fixture"
	t.Setenv("GITHUB_WEBHOOK_SECRET", secret)
	const installationID int64 = 87490113
	issue := prAutoCompleteTestIssue(t, "Engineering PR merge", installationID)
	setWorkspacePRMergeStatusForTest(t, "done")
	firePRWebhook(t, secret, installationID, 1, "Closes "+issue.Identifier, "", "engineering/fix", "opened")
	dbfx.Exec(t, `UPDATE github_pull_request SET state = 'merged' WHERE id IN (SELECT pull_request_id FROM issue_pull_request WHERE issue_id = $1)`, issue.ID)
	h := *testHandler
	recorder := &engineeringRecorder{err: &engineering.Rejection{Message: "Verification pending"}}
	h.EngineeringWorker = recorder
	h.maybeAutoCompleteIssue(context.Background(), parseUUID(testWorkspaceID), parseUUID(issue.ID), nil)
	if issueStatusForTest(t, issue.ID) != "in_progress" || len(recorder.inputs) != 1 {
		t.Fatal("PR automation bypassed completion gate")
	}
	recorder.err = nil
	recorder.response = json.RawMessage(`{"configured":true,"allowed":true}`)
	h.maybeAutoCompleteIssue(context.Background(), parseUUID(testWorkspaceID), parseUUID(issue.ID), nil)
	if issueStatusForTest(t, issue.ID) != "done" {
		t.Fatal("verified PR automation did not complete issue")
	}
}

func TestEngineeringCompletionReopenBeforeConfiguration(t *testing.T) {
	issueID := dbfx.Issue(t, "Completed issue configuration", testutil.Cols{"status": "done"})
	h := *testHandler
	recorder := &engineeringRecorder{}
	h.EngineeringWorker = recorder
	testutil.Call(t, h.ConfigureEngineeringVerification, withURLParam(newRequest(http.MethodPost, "/api/issues/"+issueID+"/engineering/verification", map[string]any{}), "id", issueID)).Want(http.StatusConflict)
	if len(recorder.inputs) != 0 {
		t.Fatal("configuration left a completed issue with pending work")
	}
}

type completionBatchWorker struct{ blocked string }

func (s completionBatchWorker) Call(_ context.Context, input any) (json.RawMessage, error) {
	request := input.(map[string]any)
	if request["actor"].(map[string]string)["issueId"] == s.blocked {
		return nil, &engineering.Rejection{Message: "Verification pending"}
	}
	return json.RawMessage(`{"configured":false,"allowed":true}`), nil
}
