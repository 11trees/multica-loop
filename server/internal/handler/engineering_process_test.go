package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestEngineeringProcessControlPlaneIdentityAndTerminalCleanup(t *testing.T) {
	_, taskToken, taskID, agentID, issueID := engineeringRunFixture(t)
	h := *testHandler
	recorder := &engineeringRecorder{response: json.RawMessage(`{"reserved":true,"status":"launching","bound":true,"exited":true}`)}
	h.EngineeringWorker = recorder
	user, err := h.Queries.GetUser(context.Background(), parseUUID(testUserID))
	if err != nil {
		t.Fatal(err)
	}
	credential, err := h.issueJWT(user)
	if err != nil {
		t.Fatal(err)
	}
	task, err := h.Queries.GetAgentTask(context.Background(), parseUUID(taskID))
	if err != nil {
		t.Fatal(err)
	}
	claim := task.DispatchedAt.Time.Format(time.RFC3339Nano)
	body := map[string]any{"operation": "reserve", "allocation_id": uuid.NewString(), "dispatched_at": claim, "host_id": "fixture-boot"}
	handler := middleware.DaemonAuth(h.Queries, nil, nil, nil)(http.HandlerFunc(h.RecordEngineeringProcess))
	request := func(token string, input map[string]any) *http.Request {
		raw, _ := json.Marshal(input)
		req := withURLParam(httptest.NewRequest(http.MethodPost, "/engineering-process", strings.NewReader(string(raw))), "taskId", taskID)
		req.Header.Set("Authorization", "Bearer "+token)
		return req
	}
	testutil.Call(t, handler.ServeHTTP, request(taskToken, body)).Want(http.StatusUnauthorized)
	body["dispatched_at"] = "2000-01-01T00:00:00Z"
	testutil.Call(t, handler.ServeHTTP, request(credential, body)).Want(http.StatusConflict)
	body["dispatched_at"] = claim
	body["runtime_id"] = uuid.NewString()
	testutil.Call(t, handler.ServeHTTP, request(credential, body)).Want(http.StatusBadRequest)
	delete(body, "runtime_id")
	if len(recorder.inputs) != 0 {
		t.Fatal("Untrusted physical facts reached the worker")
	}
	testutil.Call(t, handler.ServeHTTP, request(credential, body)).Want(http.StatusOK)
	actor := recorder.inputs[0]["actor"].(map[string]any)
	payload := recorder.inputs[0]["payload"].(map[string]any)
	if actor["kind"] != "daemon" || actor["issueId"] != issueID || actor["agentId"] != agentID || payload["runtime_id"] != uuidToString(task.RuntimeID) {
		t.Fatalf("Physical identity was not projected: %v", recorder.inputs[0])
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='cancelled' WHERE id=$1", taskID)
	testutil.Call(t, handler.ServeHTTP, request(credential, body)).Want(http.StatusConflict)
	body["operation"] = "exit"
	body["pid"] = 42
	body["exit_confirmed"] = false
	testutil.Call(t, handler.ServeHTTP, request(credential, body)).Want(http.StatusOK)
	if len(recorder.inputs) != 2 || recorder.inputs[1]["payload"].(map[string]any)["exit_confirmed"] != false {
		t.Fatal("Terminal native task could not retain an uncertain physical process")
	}
}
