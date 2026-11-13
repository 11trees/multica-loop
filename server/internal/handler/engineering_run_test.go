package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func engineeringRunFixture(t *testing.T) (http.Handler, string, string, string, string) {
	t.Helper()
	runtimeID := dbfx.Runtime(t, "Engineering runtime")
	agentID := dbfx.Agent(t, "Engineering verifier", runtimeID)
	issueID := dbfx.Issue(t, "Engineering unit")
	taskID := dbfx.Task(t, agentID, testutil.Cols{
		"issue_id": issueID, "runtime_id": runtimeID, "status": "running", "attempt": 1,
		"dispatched_at": testutil.Raw("now() - interval '1 minute'"),
		"started_at":    testutil.Raw("now() - interval '30 seconds'"),
	})
	token := "mat_engineering_" + taskID
	dbfx.Insert(t, "task_token", testutil.Cols{
		"token_hash": auth.HashToken(token), "task_id": taskID, "agent_id": agentID,
		"workspace_id": testWorkspaceID, "user_id": testUserID,
		"expires_at": testutil.Raw("now() + interval '1 hour'"),
	})
	handler := middleware.Auth(testHandler.Queries, nil, nil, nil)(
		middleware.RequireWorkspaceMember(testHandler.Queries)(http.HandlerFunc(testHandler.GetEngineeringRunContext)),
	)
	return handler, token, taskID, agentID, issueID
}

func engineeringRunRequest(token string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/engineering/run", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	return req
}

func TestEngineeringRunContext(t *testing.T) {
	handler, token, taskID, agentID, issueID := engineeringRunFixture(t)
	req := engineeringRunRequest(token)
	// Both identity headers and arbitrary run selectors are untrusted.
	req.Header.Set("X-Task-ID", testUserID)
	req.Header.Set("X-Agent-ID", testUserID)
	req.URL.RawQuery = "task_id=" + testUserID + "&issue_id=" + testUserID + "&attempt=1000"
	var response EngineeringRunContextResponse
	result := testutil.Call(t, handler.ServeHTTP, req).Want(http.StatusOK).JSON(&response)
	if response.APIVersion != 1 || response.WorkspaceID != testWorkspaceID || response.TaskID != taskID || response.AgentID != agentID || response.IssueID != issueID || response.Attempt != 1 {
		t.Fatalf("context did not resolve the authenticated task: %+v", response)
	}
	if response.RuntimeID == "" || response.Status != "running" || response.ClaimID == "" || response.AttemptID != taskID+":"+response.ClaimID {
		t.Fatalf("incomplete run identity: %+v", response)
	}
	if result.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("run identity must not be cached")
	}
}

func TestEngineeringRunContextRejectsNonRunningAndUnboundTasks(t *testing.T) {
	for _, status := range []string{"queued", "dispatched", "completed", "failed", "cancelled"} {
		t.Run(status, func(t *testing.T) {
			handler, token, taskID, _, _ := engineeringRunFixture(t)
			dbfx.Exec(t, `UPDATE agent_task_queue SET status = $1 WHERE id = $2`, status, taskID)
			testutil.Call(t, handler.ServeHTTP, engineeringRunRequest(token)).Want(http.StatusConflict)
		})
	}
	for _, tc := range []struct{ name, sql string }{
		{"no issue", `UPDATE agent_task_queue SET issue_id = NULL WHERE id = $1`},
		{"no dispatch", `UPDATE agent_task_queue SET dispatched_at = NULL WHERE id = $1`},
		{"not started", `UPDATE agent_task_queue SET started_at = NULL WHERE id = $1`},
		{"already completed", `UPDATE agent_task_queue SET completed_at = now() WHERE id = $1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler, token, taskID, _, _ := engineeringRunFixture(t)
			dbfx.Exec(t, tc.sql, taskID)
			testutil.Call(t, handler.ServeHTTP, engineeringRunRequest(token)).Want(http.StatusConflict)
		})
	}
}

func TestEngineeringRunContextFencesReclaimedCredentials(t *testing.T) {
	handler, token, taskID, _, _ := engineeringRunFixture(t)
	var first EngineeringRunContextResponse
	testutil.Call(t, handler.ServeHTTP, engineeringRunRequest(token)).Want(http.StatusOK).JSON(&first)
	// A successful reclaim changes the claim timestamp, even at the same attempt.
	dbfx.Exec(t, `UPDATE task_token SET created_at = now() - interval '2 minutes' WHERE task_id = $1`, taskID)
	testutil.Call(t, handler.ServeHTTP, engineeringRunRequest(token)).Want(http.StatusForbidden)
	dbfx.Exec(t, `UPDATE agent_task_queue SET dispatched_at = now() - interval '1 second' WHERE id = $1`, taskID)
	dbfx.Exec(t, `UPDATE task_token SET created_at = now() WHERE task_id = $1`, taskID)
	var current EngineeringRunContextResponse
	testutil.Call(t, handler.ServeHTTP, engineeringRunRequest(token)).Want(http.StatusOK).JSON(&current)
	if first.AttemptID == current.AttemptID || first.Attempt != current.Attempt {
		t.Fatal("new claim must have a different identity even when attempt is unchanged")
	}
}

func TestEngineeringRunContextRejectsCredentialScopeChanges(t *testing.T) {
	t.Run("issue in another workspace", func(t *testing.T) {
		handler, token, taskID, _, _ := engineeringRunFixture(t)
		workspace := dbfx.Workspace(t, "Foreign engineering workspace", "engineering-"+taskID)
		issue := dbfx.Issue(t, "Foreign engineering issue", testutil.Cols{"workspace_id": workspace})
		dbfx.Exec(t, `UPDATE agent_task_queue SET issue_id = $1 WHERE id = $2`, issue, taskID)
		testutil.Call(t, handler.ServeHTTP, engineeringRunRequest(token)).Want(http.StatusNotFound)
	})
	t.Run("workspace selector", func(t *testing.T) {
		handler, token, _, _, _ := engineeringRunFixture(t)
		req := engineeringRunRequest(token)
		req.Header.Set("X-Workspace-ID", testUserID)
		testutil.Call(t, handler.ServeHTTP, req).Want(http.StatusForbidden)
	})
	t.Run("agent mismatch", func(t *testing.T) {
		handler, token, taskID, _, _ := engineeringRunFixture(t)
		other := dbfx.Agent(t, "Other engineering agent", "")
		dbfx.Exec(t, `UPDATE task_token SET agent_id = $1 WHERE task_id = $2`, other, taskID)
		testutil.Call(t, handler.ServeHTTP, engineeringRunRequest(token)).Want(http.StatusForbidden)
	})
	t.Run("human identity forgery", func(t *testing.T) {
		handler, _, taskID, agentID, _ := engineeringRunFixture(t)
		user, err := testHandler.Queries.GetUser(context.Background(), parseUUID(testUserID))
		if err != nil {
			t.Fatal(err)
		}
		session, err := testHandler.issueJWT(user)
		if err != nil {
			t.Fatal(err)
		}
		req := engineeringRunRequest(session)
		req.Header.Set("X-Actor-Source", "task_token")
		req.Header.Set("X-Task-ID", taskID)
		req.Header.Set("X-Agent-ID", agentID)
		req.Header.Set("X-Workspace-ID", testWorkspaceID)
		testutil.Call(t, handler.ServeHTTP, req).Want(http.StatusForbidden)
	})
	t.Run("expired token", func(t *testing.T) {
		handler, token, taskID, _, _ := engineeringRunFixture(t)
		dbfx.Exec(t, `UPDATE task_token SET expires_at = now() - interval '1 minute' WHERE task_id = $1`, taskID)
		response := testutil.Call(t, handler.ServeHTTP, engineeringRunRequest(token)).Want(http.StatusUnauthorized)
		if strings.Contains(response.Body.String(), token) {
			t.Fatal("error must not expose task credentials")
		}
	})
}
