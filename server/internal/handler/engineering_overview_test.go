package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestEngineeringOverviewAvailabilityAndRunTarget(t *testing.T) {
	runtimeID := dbfx.Runtime(t, "Engineering control runtime", testutil.Cols{"runtime_mode": "local", "daemon_id": "engineering-panel-test"})
	agentID := dbfx.Agent(t, "Frozen verifier", runtimeID)
	otherID := dbfx.Agent(t, "Different assignee", runtimeID)
	projectID := dbfx.Project(t, "Engineering panel project")
	issueID := dbfx.Issue(t, "Engineering panel issue", testutil.Cols{"project_id": projectID, "assignee_type": "agent", "assignee_id": otherID, "status": "todo"})
	h := *testHandler
	h.EngineeringWorker = nil
	request := func(method string, body any) *http.Request {
		return withURLParam(newRequest(method, "/api/issues/"+issueID+"/engineering", body), "id", issueID)
	}
	var disabled map[string]any
	testutil.Call(t, h.GetEngineeringOverview, request(http.MethodGet, nil)).Want(http.StatusOK).JSON(&disabled)
	if disabled["enabled"] != false {
		t.Fatal("disabled engineering was advertised")
	}
	recorder := &engineeringRecorder{response: json.RawMessage(`{"enabled":true,"configured":false}`)}
	h.EngineeringWorker = recorder
	var overview map[string]any
	testutil.Call(t, h.GetEngineeringOverview, request(http.MethodGet, nil)).Want(http.StatusOK).JSON(&overview)
	if overview["has_active_run"] != false {
		t.Fatal("wrong issue run availability")
	}
	recorder.response = json.RawMessage(`{"agent_id":"` + agentID + `"}`)
	dbfx.Insert(t, "project_resource", testutil.Cols{"project_id": projectID, "workspace_id": testWorkspaceID, "resource_type": "local_directory", "resource_ref": json.RawMessage(`{"local_path":"/fixture/repo","daemon_id":"different-daemon","execution_mode":"in_place"}`)})
	testutil.Call(t, h.RunEngineering, request(http.MethodPost, map[string]any{"expected_revision": 1, "expected_sequence": 7})).Want(http.StatusConflict)
	dbfx.Insert(t, "project_resource", testutil.Cols{"project_id": projectID, "workspace_id": testWorkspaceID, "resource_type": "local_directory", "resource_ref": json.RawMessage(`{"local_path":"/fixture/repo","daemon_id":"engineering-panel-test","execution_mode":"in_place"}`)})
	var run AgentTaskResponse
	testutil.Call(t, h.RunEngineering, request(http.MethodPost, map[string]any{"expected_revision": 1, "expected_sequence": 7})).Want(http.StatusAccepted).JSON(&run)
	if run.AgentID != agentID || run.IssueID != issueID {
		t.Fatalf("wrong frozen role queued: %+v", run)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id=$1`, issueID) })
	current, err := h.Queries.GetIssue(context.Background(), parseUUID(issueID))
	if err != nil {
		t.Fatal(err)
	}
	if uuidToString(current.AssigneeID) != otherID {
		t.Fatal("engineering dispatch changed the issue assignee")
	}
	testutil.Call(t, h.RunEngineering, request(http.MethodPost, map[string]any{"expected_revision": 1, "expected_sequence": 7})).Want(http.StatusConflict)
	var count int
	dbfx.QueryRow(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1`, issueID).Scan(&count)
	if count != 1 {
		t.Fatalf("repeat dispatch created %d runs", count)
	}
}

func TestEngineeringControlsRejectTaskCredentials(t *testing.T) {
	_, token, _, _, issueID := engineeringRunFixture(t)
	h := *testHandler
	recorder := &engineeringRecorder{}
	h.EngineeringWorker = recorder
	for _, handler := range []http.HandlerFunc{h.GetEngineeringOverview, h.RunEngineering} {
		r := withURLParam(httptest.NewRequest(http.MethodPost, "/api/issues/"+issueID+"/engineering", strings.NewReader(`{"expected_revision":1,"expected_sequence":0}`)), "id", issueID)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("X-Workspace-ID", testWorkspaceID)
		auth := middleware.Auth(h.Queries, nil, nil, nil)(middleware.RequireWorkspaceMember(h.Queries)(handler))
		testutil.Call(t, auth.ServeHTTP, r).Want(http.StatusForbidden)
	}
	if len(recorder.inputs) != 0 {
		t.Fatal("machine credentials reached human engineering controls")
	}
}
