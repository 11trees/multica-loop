package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

type directWorkerFixture struct {
	scope        engineeringDirectScope
	acknowledged bool
	failAck      bool
}

func (f *directWorkerFixture) Call(_ context.Context, input any) (json.RawMessage, error) {
	value := input.(map[string]any)
	switch value["action"] {
	case "completion", "direct-scope":
		return json.Marshal(map[string]any{"configured": true, "allowed": true, "direct_scope": f.scope})
	case "direct-completed":
		if f.failAck {
			f.failAck = false
			return nil, fmt.Errorf("acknowledgement interrupted")
		}
		f.acknowledged = true
		return json.RawMessage(`{"acknowledged":true}`), nil
	case "parent-scope":
		return json.RawMessage(`{"managed":false}`), nil
	default:
		return nil, fmt.Errorf("unexpected Direct operation: %v", value["action"])
	}
}

func TestEngineeringDirectFreezesActualNativeAgentProjectAndResource(t *testing.T) {
	runtimeID := dbfx.Runtime(t, "Direct runtime", testutil.Cols{"runtime_mode": "local", "daemon_id": "direct-config-test"})
	agentID := dbfx.Agent(t, "Direct agent", runtimeID)
	projectID := dbfx.Project(t, "Direct project")
	issueID := dbfx.Issue(t, "Direct input", testutil.Cols{"project_id": projectID, "status": "todo"})
	dbfx.Insert(t, "project_resource", testutil.Cols{"project_id": projectID, "workspace_id": testWorkspaceID, "resource_type": "local_directory", "resource_ref": json.RawMessage(`{"local_path":"/fixture/direct","daemon_id":"direct-config-test","execution_mode":"in_place"}`)})
	h := *testHandler
	worker := &engineeringRecorder{response: json.RawMessage(`{"configured":true}`)}
	h.EngineeringWorker = worker
	input := map[string]any{"expected_revision": 0, "agent_id": agentID, "repository_path": "/fixture/direct", "input": "Write a faithful summary"}
	request := func() *http.Request {
		return withURLParam(newRequest(http.MethodPost, "/configure-direct", input), "id", issueID)
	}
	testutil.Call(t, h.ConfigureEngineeringDirect, request()).Want(http.StatusOK)
	payload := worker.inputs[0]["payload"].(map[string]any)
	if payload["agent_id"] != agentID || payload["project_id"] != projectID || len(payload["execution_resources"].([]any)) != 1 {
		t.Fatal("Direct lost native role or project binding")
	}
	input["project_id"] = projectID
	testutil.Call(t, h.ConfigureEngineeringDirect, request()).Want(http.StatusBadRequest)
	if len(worker.inputs) != 1 {
		t.Fatal("client supplied identity reached Direct worker")
	}
}

func TestEngineeringDirectCompletesOnlyAnIdleSubmittedNativeAttemptAndRecoversAcknowledgement(t *testing.T) {
	ctx := context.Background()
	runtimeID := dbfx.Runtime(t, "Direct completion runtime")
	agentID := dbfx.Agent(t, "Direct completion agent", runtimeID)
	projectID := dbfx.Project(t, "Direct completion project")
	issueID := dbfx.Issue(t, "Direct result", testutil.Cols{"project_id": projectID, "status": "todo"})
	taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "running", "dispatched_at": testutil.Raw("now()"), "started_at": testutil.Raw("now()"), "originator_user_id": testUserID, "accountable_user_id": testUserID})
	t.Cleanup(func() { testPool.Exec(ctx, "DELETE FROM agent_task_queue WHERE id=$1", taskID) })
	task, err := testHandler.Queries.GetAgentTask(ctx, parseUUID(taskID))
	if err != nil {
		t.Fatal(err)
	}
	worker := &directWorkerFixture{scope: engineeringDirectScope{ProjectID: projectID, AgentID: agentID, AttemptID: taskID + ":" + strconv.FormatInt(task.DispatchedAt.Time.UnixMicro(), 10), ResultHash: strings.Repeat("a", 64)}, failAck: true}
	h := *testHandler
	h.EngineeringWorker = worker
	item := engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: issueID, UserID: testUserID, AgentID: agentID, Reason: "direct_submitted"}
	if err = h.dispatchEngineeringContinuation(ctx, item); err != nil {
		t.Fatal(err)
	}
	issue, _ := h.Queries.GetIssue(ctx, parseUUID(issueID))
	if issue.Status != "todo" || worker.acknowledged {
		t.Fatal("unfinished Direct process authorized native Done")
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", taskID)
	if err = h.dispatchEngineeringContinuation(ctx, item); err == nil || !strings.Contains(err.Error(), "interrupted") {
		t.Fatalf("expected interrupted post-Done acknowledgement: %v", err)
	}
	issue, _ = h.Queries.GetIssue(ctx, parseUUID(issueID))
	if issue.Status != "done" {
		t.Fatal("submitted Direct result did not pass the native completion writer")
	}
	revision := issue.Revision
	if err = h.dispatchEngineeringContinuation(ctx, item); err != nil {
		t.Fatal(err)
	}
	issue, _ = h.Queries.GetIssue(ctx, parseUUID(issueID))
	if !worker.acknowledged || issue.Revision != revision {
		t.Fatal("Direct acknowledgement retry rewrote the native issue")
	}
	worker.scope.AttemptID = taskID + ":0"
	if err = h.directNativeScope(ctx, issue, worker.scope); err == nil {
		t.Fatal("changed Direct claim authorized completion")
	}
	worker.scope.AttemptID = taskID + ":" + strconv.FormatInt(task.DispatchedAt.Time.UnixMicro(), 10)
	dbfx.Exec(t, "UPDATE issue SET project_id=NULL WHERE id=$1", issueID)
	issue, _ = h.Queries.GetIssue(ctx, parseUUID(issueID))
	if err = h.directNativeScope(ctx, issue, worker.scope); err == nil {
		t.Fatal("moved Direct result authorized native completion")
	}
}

func TestEngineeringDirectClaimProvidesItsOwnProtocolAndRefusesMovedProjects(t *testing.T) {
	runtimeID := dbfx.Runtime(t, "Direct claim runtime")
	agentID := dbfx.Agent(t, "Direct claim agent", runtimeID)
	projectID := dbfx.Project(t, "Direct claim project")
	issueID := dbfx.Issue(t, "Direct claim", testutil.Cols{"project_id": projectID})
	taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "dispatched", "dispatched_at": testutil.Raw("now()")})
	task, _ := testHandler.Queries.GetAgentTask(context.Background(), parseUUID(taskID))
	runtime, _ := testHandler.Queries.GetAgentRuntime(context.Background(), parseUUID(runtimeID))
	data, _ := json.Marshal(map[string]any{"configured": true, "chain": "direct", "direct_project_id": projectID, "repository_path": "/fixture/direct", "code_version": strings.Repeat("a", 40)})
	h := *testHandler
	h.EngineeringWorker = &engineeringRecorder{response: data}
	response, _, _, _, _, failure := h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &task, runtime, runtimeID, testWorkspaceID)
	if failure != nil || response.EngineeringChain != "direct" || !strings.Contains(response.Agent.Instructions, "direct-run") || strings.Contains(response.Agent.Instructions, "First run `multica engineering start`") {
		t.Fatalf("Direct claim inherited the wrong protocol: %+v", failure)
	}
	data, _ = json.Marshal(map[string]any{"configured": true, "chain": "direct", "direct_project_id": projectID, "repository_path": "/fixture/direct", "code_version": ""})
	h.EngineeringWorker = &engineeringRecorder{response: data}
	response, _, _, _, _, failure = h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &task, runtime, runtimeID, testWorkspaceID)
	if failure != nil || response.EngineeringChain != "direct" || response.EngineeringCommit != "" {
		t.Fatalf("plain Direct directory was rejected: %+v", failure)
	}
	dbfx.Exec(t, "UPDATE issue SET project_id=NULL WHERE id=$1", issueID)
	_, _, _, _, _, failure = h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &task, runtime, runtimeID, testWorkspaceID)
	if failure == nil {
		t.Fatal("moved Direct project reached native launch")
	}
}
