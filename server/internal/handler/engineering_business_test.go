package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestEngineeringBusinessConfigurationDerivesProjectRolesAndResourcesFromNativeState(t *testing.T) {
	runtimeID := dbfx.Runtime(t, "Business role runtime", testutil.Cols{"runtime_mode": "local", "daemon_id": "business-config-test"})
	projectID := dbfx.Project(t, "Business input project")
	issueID := dbfx.Issue(t, "Business input", testutil.Cols{"project_id": projectID, "status": "todo"})
	dbfx.Insert(t, "project_resource", testutil.Cols{"project_id": projectID, "workspace_id": testWorkspaceID, "resource_type": "local_directory", "resource_ref": json.RawMessage(`{"local_path":"/fixture/business","daemon_id":"business-config-test","execution_mode":"in_place"}`)})
	roles := map[string]string{}
	for _, stage := range []string{"intent", "business_design", "specification", "review"} {
		roles[stage] = dbfx.Agent(t, "Business "+stage, runtimeID)
	}
	h := *testHandler
	worker := &engineeringRecorder{response: json.RawMessage(`{"contract":{"binding":{"revision":1}},"draft":null}`)}
	h.EngineeringWorker = worker
	input := map[string]any{"expected_revision": 0, "repository_path": "/fixture/business", "input": "Reader continues the selected item", "roles": roles, "decision_mode": "balanced", "auto_continue": true}
	request := func(body any) *http.Request {
		return withURLParam(newRequest(http.MethodPost, "/api/issues/"+issueID+"/engineering/business-analysis", body), "id", issueID)
	}
	var result map[string]bool
	testutil.Call(t, h.ConfigureEngineeringBusiness, request(input)).Want(http.StatusOK).JSON(&result)
	if !result["configured"] || len(worker.inputs) != 1 {
		t.Fatal("business configuration was not accepted exactly once")
	}
	invocation := worker.inputs[0]
	actor := invocation["actor"].(map[string]any)
	payload := invocation["payload"].(map[string]any)
	if invocation["action"] != "configure-business" || actor["userId"] != testUserID || actor["workspaceId"] != testWorkspaceID || actor["issueId"] != issueID || payload["project_id"] != projectID || len(payload["execution_resources"].([]any)) != 4 {
		t.Fatalf("configuration lost its actual native scope: %+v", invocation)
	}
	for key, id := range roles {
		if payload["roles"].(map[string]any)[key] != id {
			t.Fatal("business role identity changed")
		}
	}
	for _, field := range []string{"project_id", "execution_resources", "created_by"} {
		input[field] = "client supplied"
		testutil.Call(t, h.ConfigureEngineeringBusiness, request(input)).Want(http.StatusBadRequest)
		delete(input, field)
	}
	if len(worker.inputs) != 1 {
		t.Fatal("client-supplied host scope reached the worker")
	}
	active := dbfx.Task(t, roles["intent"], testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "running"})
	t.Cleanup(func() { testPool.Exec(context.Background(), "DELETE FROM agent_task_queue WHERE id=$1", active) })
	testutil.Call(t, h.ConfigureEngineeringBusiness, request(input)).Want(http.StatusConflict)
}

func TestEngineeringBusinessClaimsRetainFrozenProjectAndReadonlyInstructions(t *testing.T) {
	for _, chain := range []string{"idea-context", "business-design", "requirement-spec", "spec-review"} {
		t.Run(chain, func(t *testing.T) {
			runtimeID := dbfx.Runtime(t, "Business claim runtime")
			agentID := dbfx.Agent(t, "Business claim agent", runtimeID)
			projectID := dbfx.Project(t, "Business claim project")
			issueID := dbfx.Issue(t, "Business claim issue", testutil.Cols{"project_id": projectID})
			taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "dispatched", "dispatched_at": testutil.Raw("now()")})
			task, err := testHandler.Queries.GetAgentTask(context.Background(), parseUUID(taskID))
			if err != nil {
				t.Fatal(err)
			}
			runtime, err := testHandler.Queries.GetAgentRuntime(context.Background(), parseUUID(runtimeID))
			if err != nil {
				t.Fatal(err)
			}
			body, _ := json.Marshal(map[string]any{"configured": true, "chain": chain, "business_project_id": projectID, "repository_path": "/fixture/business", "code_version": strings.Repeat("a", 40)})
			h := *testHandler
			h.EngineeringWorker = &engineeringRecorder{response: body}
			response, _, _, _, _, failure := h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &task, runtime, runtimeID, testWorkspaceID)
			if failure != nil || response.EngineeringChain != chain || response.Agent == nil || !strings.Contains(response.Agent.Instructions, "readonly business analysis") {
				t.Fatalf("business role claim omitted its boundary: %+v, %+v", response, failure)
			}
			dbfx.Exec(t, `UPDATE issue SET project_id=NULL WHERE id=$1`, issueID)
			_, _, _, _, _, failure = h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &task, runtime, runtimeID, testWorkspaceID)
			if failure == nil {
				t.Fatal("changed native project was accepted for the business claim")
			}
		})
	}
}
