package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestEngineeringReceiptCredentialBoundary(t *testing.T) {
	_, agentToken, taskID, agentID, issueID := engineeringRunFixture(t)
	projectID := dbfx.Project(t, "Receipt native project")
	dbfx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", issueID, projectID)
	h := *testHandler
	recorder := &engineeringRecorder{}
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
	body := `{"dispatched_at":"` + task.DispatchedAt.Time.Format(time.RFC3339Nano) + `","id":"command","sequence":1,"result":{"command":"npm test","cwd":"/fixture","status":"completed","exit_code":0}}`
	handler := middleware.DaemonAuth(h.Queries, nil, nil, nil)(http.HandlerFunc(h.CaptureEngineeringReceipt))
	request := func(credential, payload string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/api/daemon/tasks/"+taskID+"/engineering-receipts", strings.NewReader(payload))
		r.Header.Set("Authorization", "Bearer "+credential)
		return withURLParam(r, "taskId", taskID)
	}
	testutil.Call(t, handler.ServeHTTP, request(agentToken, body)).Want(http.StatusUnauthorized)
	testutil.Call(t, handler.ServeHTTP, request(token, strings.Replace(body, task.DispatchedAt.Time.Format(time.RFC3339Nano), "2000-01-01T00:00:00Z", 1))).Want(http.StatusConflict)
	if len(recorder.inputs) != 0 {
		t.Fatal("untrusted receipt reached worker")
	}
	testutil.Call(t, handler.ServeHTTP, request(token, body)).Want(http.StatusOK)
	actor := recorder.inputs[0]["actor"].(map[string]any)
	if actor["kind"] != "daemon" || actor["agentId"] != agentID || actor["issueId"] != issueID || actor["projectId"] != projectID {
		t.Fatalf("receipt identity was not host-derived: %+v", actor)
	}
}
