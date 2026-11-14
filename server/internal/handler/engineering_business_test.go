package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
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

func TestEngineeringEndToEndConfigurationProjectsAllTenAuthorizedNativeRoles(t *testing.T) {
	runtimeID := dbfx.Runtime(t, "End to End initial runtime", testutil.Cols{"runtime_mode": "local", "daemon_id": "e2e-config-test"})
	projectID := dbfx.Project(t, "End to End initial project")
	issueID := dbfx.Issue(t, "End to End initial issue", testutil.Cols{"project_id": projectID, "status": "todo"})
	dbfx.Insert(t, "project_resource", testutil.Cols{"project_id": projectID, "workspace_id": testWorkspaceID, "resource_type": "local_directory", "resource_ref": json.RawMessage(`{"local_path":"/fixture/end-to-end","daemon_id":"e2e-config-test","execution_mode":"in_place"}`)})
	businessRoles, deliveryRoles := map[string]string{}, map[string]string{}
	for _, key := range []string{"intent", "business_design", "specification", "review"} {
		businessRoles[key] = dbfx.Agent(t, key, runtimeID)
	}
	for _, key := range []string{"context", "planner", "analyst", "developer", "verifier", "reviewer"} {
		deliveryRoles[key] = dbfx.Agent(t, key, runtimeID)
	}
	h := *testHandler
	worker := &engineeringRecorder{response: json.RawMessage(`{"configured":true}`)}
	h.EngineeringWorker = worker
	input := map[string]any{"expected_revision": 0, "repository_path": "/fixture/end-to-end", "input": "Reader outcome", "roles": businessRoles, "delivery": map[string]any{"roles": deliveryRoles, "max_reworks": 2}, "decision_mode": "balanced", "auto_continue": true}
	request := func() *http.Request {
		return withURLParam(newRequest(http.MethodPost, "/configure-business", input), "id", issueID)
	}
	testutil.Call(t, h.ConfigureEngineeringBusiness, request()).Want(http.StatusOK)
	payload := worker.inputs[0]["payload"].(map[string]any)
	if len(payload["execution_resources"].([]any)) != 10 || payload["delivery"].(map[string]any)["maxReworks"] != float64(2) {
		t.Fatal("End to End lost its initially authorized roles or budget")
	}
	input["auto_continue"] = false
	testutil.Call(t, h.ConfigureEngineeringBusiness, request()).Want(http.StatusBadRequest)
	if len(worker.inputs) != 1 {
		t.Fatal("invalid authorization reached worker")
	}
}

type endToEndWorker struct {
	projectID  string
	roles      map[string]string
	handoffs   int
	preflights int
}

func (f *endToEndWorker) Call(_ context.Context, input any) (json.RawMessage, error) {
	value := input.(map[string]any)
	switch value["action"] {
	case "parent-scope":
		return json.RawMessage(`{"managed":false}`), nil
	case "end-to-end-scope":
		if value["payload"] != nil {
			f.preflights++
		}
		return json.Marshal(map[string]any{"project_id": f.projectID, "user_id": testUserID, "roles": f.roles, "handed_off": false})
	case "business-handoff":
		f.handoffs++
		return json.RawMessage(`{"handed_off":true}`), nil
	default:
		return nil, fmt.Errorf("unexpected End to End worker operation: %v", value["action"])
	}
}
func TestEngineeringEndToEndHandoffRevalidatesNativeIdleProjectAndRoleAuthority(t *testing.T) {
	runtimeID := dbfx.Runtime(t, "End to End handoff runtime", testutil.Cols{"runtime_mode": "local", "daemon_id": "e2e-handoff-test"})
	projectID := dbfx.Project(t, "End to End handoff project")
	issueID := dbfx.Issue(t, "End to End handoff issue", testutil.Cols{"project_id": projectID, "status": "todo"})
	dbfx.Insert(t, "project_resource", testutil.Cols{"project_id": projectID, "workspace_id": testWorkspaceID, "resource_type": "local_directory", "resource_ref": json.RawMessage(`{"local_path":"/fixture/end-to-end","daemon_id":"e2e-handoff-test","execution_mode":"in_place"}`)})
	roles := map[string]string{}
	for _, key := range []string{"context", "planner", "analyst", "developer", "verifier", "reviewer"} {
		roles[key] = dbfx.Agent(t, key, runtimeID)
	}
	h := *testHandler
	worker := &endToEndWorker{projectID: projectID, roles: roles}
	h.EngineeringWorker = worker
	item := engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: issueID, UserID: testUserID, AgentID: roles["context"], ExpectedRevision: 1, ExpectedSequence: 8, Reason: "business_handoff"}
	taskID := dbfx.Task(t, roles["context"], testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "running"})
	t.Cleanup(func() { testPool.Exec(context.Background(), "DELETE FROM agent_task_queue WHERE id=$1", taskID) })
	if err := h.dispatchEngineeringContinuation(context.Background(), item); err != nil {
		t.Fatal(err)
	}
	if worker.handoffs != 0 {
		t.Fatal("unfinished run crossed automatic handoff")
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", taskID)
	if err := h.dispatchEngineeringContinuation(context.Background(), item); err != nil {
		t.Fatal(err)
	}
	if worker.handoffs != 1 || worker.preflights != 1 {
		t.Fatal("handoff omitted frozen role/resource preflight")
	}
	dbfx.Exec(t, "UPDATE issue SET project_id=NULL WHERE id=$1", issueID)
	if err := h.dispatchEngineeringContinuation(context.Background(), item); err == nil {
		t.Fatal("changed project crossed handoff")
	}
	dbfx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", issueID, projectID)
	dbfx.Exec(t, "UPDATE agent SET archived_at=now() WHERE id=$1", roles["developer"])
	if err := h.dispatchEngineeringContinuation(context.Background(), item); err == nil {
		t.Fatal("revoked delivery role crossed handoff")
	}
	if worker.handoffs != 1 {
		t.Fatal("rejected scope changed business ownership")
	}
}

func TestEngineeringEndToEndCompletionRetainsItsOriginalNativeProject(t *testing.T) {
	projectID := dbfx.Project(t, "End to End completion project")
	issueID := dbfx.Issue(t, "End to End completion", testutil.Cols{"project_id": projectID, "status": "todo"})
	h := *testHandler
	data, _ := json.Marshal(map[string]any{"configured": true, "allowed": true, "business_project_id": projectID})
	h.EngineeringWorker = &engineeringRecorder{response: data}
	params := db.UpdateIssueParams{ID: parseUUID(issueID), Status: pgtype.Text{String: "done", Valid: true}, ProjectID: parseUUID(projectID)}
	if err := h.requireEngineeringCompletion(context.Background(), parseUUID(testWorkspaceID), params); err != nil {
		t.Fatal(err)
	}
	dbfx.Exec(t, "UPDATE issue SET project_id=NULL WHERE id=$1", issueID)
	params.ProjectID = pgtype.UUID{}
	if err := h.requireEngineeringCompletion(context.Background(), parseUUID(testWorkspaceID), params); err == nil {
		t.Fatal("End to End completion lost its original project")
	}
}

func TestEngineeringEndToEndClaimsFenceOriginalProjectForEveryDownstreamRole(t *testing.T) {
	for _, chain := range []string{"context", "planning", "analysis", "development", "verification", "review"} {
		t.Run(chain, func(t *testing.T) {
			runtimeID := dbfx.Runtime(t, "End to End claim runtime")
			agentID := dbfx.Agent(t, "End to End claim role", runtimeID)
			projectID := dbfx.Project(t, "End to End claim project")
			issueID := dbfx.Issue(t, "End to End claim scope", testutil.Cols{"project_id": projectID})
			taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "dispatched", "dispatched_at": testutil.Raw("now()")})
			task, err := testHandler.Queries.GetAgentTask(context.Background(), parseUUID(taskID))
			if err != nil {
				t.Fatal(err)
			}
			runtime, err := testHandler.Queries.GetAgentRuntime(context.Background(), parseUUID(runtimeID))
			if err != nil {
				t.Fatal(err)
			}
			var childID string
			role := map[string]any{"configured": true, "chain": chain, "business_project_id": projectID, "repository_path": "/fixture/end-to-end", "code_version": strings.Repeat("a", 40)}
			if chain == "review" {
				planID := uuidToString(dbid.NewV7())
				hash := strings.Repeat("b", 64)
				metadata, _ := json.Marshal(map[string]any{"engineering.plan": planID, "engineering.unit": "unit", "engineering.revision": 1, "engineering.contract": hash})
				childID = dbfx.Issue(t, "End to End verified child", testutil.Cols{"project_id": projectID, "parent_issue_id": issueID, "status": "done", "metadata": json.RawMessage(metadata)})
				role["review_units"] = []engineeringReviewUnit{{IssueID: childID, PlanDraftID: planID, UnitKey: "unit", ParentRevision: 1, ContractHash: hash}}
			}
			data, _ := json.Marshal(role)
			h := *testHandler
			h.EngineeringWorker = &engineeringRecorder{response: data}
			response, _, _, _, _, failure := h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &task, runtime, runtimeID, testWorkspaceID)
			if failure != nil || response.EngineeringChain != chain {
				t.Fatalf("owning project claim failed: %+v", failure)
			}
			movedProject := dbfx.Project(t, "Moved End to End project")
			dbfx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", issueID, movedProject)
			if childID != "" {
				dbfx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", childID, movedProject)
			}
			_, _, _, _, _, failure = h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &task, runtime, runtimeID, testWorkspaceID)
			if failure == nil {
				t.Fatal("changed End to End project reached downstream native launch")
			}
		})
	}
}
