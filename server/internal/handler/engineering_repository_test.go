package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestEngineeringRepositoryCredentialBoundary(t *testing.T) {
	_, agentToken, taskID, agentID, issueID := engineeringRunFixture(t)
	h := *testHandler
	recorder := &engineeringRecorder{response: json.RawMessage(`{"bound":true}`)}
	h.EngineeringWorker = recorder
	user, err := h.Queries.GetUser(context.Background(), parseUUID(testUserID))
	if err != nil {
		t.Fatal(err)
	}
	token, err := h.issueJWT(user)
	if err != nil {
		t.Fatal(err)
	}
	task, err := h.Queries.GetAgentTask(context.Background(), parseUUID(taskID))
	if err != nil {
		t.Fatal(err)
	}
	body := `{"dispatched_at":"` + task.DispatchedAt.Time.Format(time.RFC3339Nano) + `","work_dir":"/fixture/worktree","mode":"worktree","overlays":[]}`
	handler := middleware.DaemonAuth(h.Queries, nil, nil, nil)(http.HandlerFunc(h.BindEngineeringRepository))
	request := func(credential, payload string) *http.Request {
		r := withURLParam(httptest.NewRequest(http.MethodPost, "/api/daemon/tasks/"+taskID+"/engineering-repository", strings.NewReader(payload)), "taskId", taskID)
		r.Header.Set("Authorization", "Bearer "+credential)
		return r
	}
	testutil.Call(t, handler.ServeHTTP, request(agentToken, body)).Want(http.StatusUnauthorized)
	testutil.Call(t, handler.ServeHTTP, request(token, strings.Replace(body, task.DispatchedAt.Time.Format(time.RFC3339Nano), "2000-01-01T00:00:00Z", 1))).Want(http.StatusConflict)
	if len(recorder.inputs) != 0 {
		t.Fatal("untrusted binding reached worker")
	}
	testutil.Call(t, handler.ServeHTTP, request(token, body)).Want(http.StatusOK)
	input := recorder.inputs[0]
	actor := input["actor"].(map[string]any)
	if input["action"] != "bind" || actor["kind"] != "daemon" || actor["agentId"] != agentID || actor["issueId"] != issueID || actor["attemptId"] == "" {
		t.Fatalf("wrong host binding scope: %+v", input)
	}
}
