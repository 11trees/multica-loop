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

type nativeFeedbackFixture struct {
	requirementReviewFixture
	payload       map[string]any
	reopen        bool
	allow         bool
	restored      bool
	work          bool
	workPayload   map[string]any
	verify        bool
	verifyPayload map[string]any
	report        bool
	reportPayload map[string]any
	teamBinding   *engineeringTeamBinding
	teamScope     *engineeringTeamFeedbackScope
}

func (f *nativeFeedbackFixture) Call(ctx context.Context, input any) (json.RawMessage, error) {
	value := input.(map[string]any)
	var result any
	switch value["action"] {
	case "team-routing":
		if f.teamBinding == nil {
			return f.requirementReviewFixture.Call(ctx, input)
		}
		result = map[string]any{"owned": true, "binding": f.teamBinding, "profile": f.teamBinding.Profile}
	case "team-feedback-scope":
		actor := value["actor"].(map[string]string)
		if actor["kind"] != "host" || f.teamScope == nil {
			return nil, fmt.Errorf("Team work scope requires the native host")
		}
		result = f.teamScope
	case "prepare-feedback-report":
		actor := value["actor"].(map[string]string)
		if actor["kind"] != "host" || actor["workspaceId"] == "" || actor["issueId"] == "" {
			return nil, fmt.Errorf("report correction needs the native host")
		}
		f.report = true
		f.reportPayload = value["payload"].(map[string]any)
		result = map[string]bool{"configured": true}
	case "prepare-feedback-verification":
		actor := value["actor"].(map[string]string)
		if actor["kind"] != "host" || actor["workspaceId"] == "" || actor["issueId"] == "" {
			return nil, fmt.Errorf("verification needs the native host")
		}
		f.verify = true
		f.verifyPayload = value["payload"].(map[string]any)
		result = map[string]bool{"configured": true}
	case "begin-feedback":
		f.payload = value["payload"].(map[string]any)
		result = map[string]any{"configured": true, "batch_id": "019a0000-0000-7000-8000-000000000071", "reopen_required": f.reopen}
	case "cancel-feedback":
		result = map[string]bool{"cancelled": true}
	case "authorize-feedback-work":
		f.work = true
		f.workPayload = value["payload"].(map[string]any)
		result = map[string]bool{"authorized": true}
	case "feedback-restored":
		f.restored = true
		result = map[string]bool{"acknowledged": true}
	case "completion":
		result = map[string]any{"configured": true, "allowed": f.allow, "review_units": f.units}
	case "selection":
		result = map[string]any{"configured": true, "chain": "feedback-triage", "repository_path": "/fixture/repository", "code_version": strings.Repeat("a", 40), "review_units": f.units}
		if f.work {
			result = map[string]any{"configured": true, "chain": "planning", "feedback_group_id": "group", "repository_path": "/fixture/repository", "code_version": strings.Repeat("a", 40), "review_units": f.units}
		}
		if f.verify {
			result = map[string]any{"configured": true, "chain": "feedback-verify", "feedback_group_id": "group", "repository_path": "/fixture/repository", "code_version": strings.Repeat("a", 40), "review_units": f.units}
		}
		if f.report && !f.verify {
			result = map[string]any{"configured": true, "chain": "review", "report_correction": true, "feedback_group_id": "report", "repository_path": "/fixture/repository", "code_version": strings.Repeat("a", 40), "review_units": f.units}
		}
	default:
		return f.requirementReviewFixture.Call(ctx, input)
	}
	body, err := json.Marshal(result)
	return body, err
}

func TestEngineeringFeedbackCapturesNativeCommentsReopensAndRestoresOnlyAfterCompletion(t *testing.T) {
	ctx := context.Background()
	runtimeID := dbfx.Runtime(t, "Feedback runtime", testutil.Cols{"runtime_mode": "local", "daemon_id": "feedback-test"})
	agentID := dbfx.Agent(t, "Feedback triager", runtimeID)
	verifierID := dbfx.Agent(t, "Feedback verifier", runtimeID)
	projectID := dbfx.Project(t, "Feedback project")
	otherAssignee := dbfx.Agent(t, "Preserved assignee", runtimeID)
	parentID := dbfx.Issue(t, "Delivered parent", testutil.Cols{"project_id": projectID, "status": "done", "assignee_type": "agent", "assignee_id": otherAssignee})
	planID := uuidToString(dbid.NewV7())
	metadata, _ := json.Marshal(map[string]any{"engineering.plan": planID, "engineering.unit": "unit", "engineering.revision": 1, "engineering.contract": strings.Repeat("b", 64)})
	childID := dbfx.Issue(t, "Accepted child", testutil.Cols{"project_id": projectID, "parent_issue_id": parentID, "status": "done", "metadata": json.RawMessage(metadata)})
	commentID := dbfx.Comment(t, parentID, "Original feedback body")
	otherIssue := dbfx.Issue(t, "Other requirement")
	otherComment := dbfx.Comment(t, otherIssue, "Must not capture")
	dbfx.Insert(t, "project_resource", testutil.Cols{"workspace_id": testWorkspaceID, "project_id": projectID, "resource_type": "local_directory", "resource_ref": json.RawMessage(`{"local_path":"/fixture/repository","daemon_id":"feedback-test","execution_mode":"in_place"}`)})
	h := *testHandler
	worker := &nativeFeedbackFixture{requirementReviewFixture: requirementReviewFixture{units: []engineeringReviewUnit{{IssueID: childID, PlanDraftID: planID, UnitKey: "unit", ParentRevision: 1, ContractHash: strings.Repeat("b", 64)}}}, reopen: true}
	h.EngineeringWorker = worker
	request := func(body any) *http.Request {
		return withURLParam(newRequest(http.MethodPost, "/feedback", body), "id", parentID)
	}
	payload := map[string]any{"request_id": uuidToString(dbid.NewV7()), "expected_revision": 1, "expected_sequence": 25, "expected_batch_number": 0, "agent_id": agentID, "verifier_id": verifierID, "comment_ids": []string{commentID}}
	spoof := map[string]any{}
	for k, v := range payload {
		spoof[k] = v
	}
	spoof["comments"] = []string{"Client supplied snapshot"}
	testutil.Call(t, h.BeginEngineeringFeedback, request(spoof)).Want(http.StatusBadRequest)
	payload["comment_ids"] = []string{otherComment}
	testutil.Call(t, h.BeginEngineeringFeedback, request(payload)).Want(http.StatusNotFound)
	if worker.payload != nil {
		t.Fatal("foreign comment reached the worker")
	}
	payload["comment_ids"] = []string{commentID, strings.ToUpper(commentID)}
	testutil.Call(t, h.BeginEngineeringFeedback, request(payload)).Want(http.StatusBadRequest)
	payload["comment_ids"] = []string{commentID}
	testutil.Call(t, h.BeginEngineeringFeedback, request(payload)).Want(http.StatusOK)
	frozen := worker.payload["comments"].([]map[string]string)[0]
	if frozen["content"] != "Original feedback body" || frozen["version"] == "" || frozen["authorId"] == "" || worker.payload["restore_done"] != true {
		t.Fatal("native feedback snapshot did not retain actual source facts")
	}
	payload["comment_ids"] = []string{strings.ToUpper(commentID)}
	testutil.Call(t, h.BeginEngineeringFeedback, request(payload)).Want(http.StatusOK)
	if worker.payload["comments"].([]map[string]string)[0]["version"] != frozen["version"] {
		t.Fatal("UUID casing changed the captured source version")
	}
	payload["comment_ids"] = []string{commentID}
	parent, _ := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: parseUUID(parentID), WorkspaceID: parseUUID(testWorkspaceID)})
	if parent.Status != "todo" || uuidToString(parent.AssigneeID) != otherAssignee || uuidToString(parent.ProjectID) != projectID {
		t.Fatal("feedback admission lost native parent fields")
	}
	taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": parentID, "status": "dispatched", "dispatched_at": testutil.Raw("now()")})
	task, _ := h.Queries.GetAgentTask(ctx, parseUUID(taskID))
	runtime, _ := h.Queries.GetAgentRuntime(ctx, parseUUID(runtimeID))
	response, _, _, _, _, failure := h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &task, runtime, runtimeID, testWorkspaceID)
	if failure != nil || response.EngineeringChain != "feedback-triage" || !strings.Contains(response.Agent.Instructions, "frozen native comments") {
		t.Fatalf("native feedback claim failed: %+v", failure)
	}
	testutil.Call(t, h.CancelEngineeringFeedback, request(map[string]any{"batch_id": "019a0000-0000-7000-8000-000000000071", "expected_version": 1, "reason": "Stop"})).Want(http.StatusConflict)
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", taskID)
	workInput := map[string]any{"batch_id": "019a0000-0000-7000-8000-000000000071", "expected_version": 1, "planner_agent_id": agentID}
	workSpoof := map[string]any{"batch_id": workInput["batch_id"], "expected_version": 1, "planner_agent_id": agentID, "execution_resources": []string{"/forged"}}
	testutil.Call(t, h.AuthorizeEngineeringFeedbackWork, request(workSpoof)).Want(http.StatusBadRequest)
	testutil.Call(t, h.AuthorizeEngineeringFeedbackWork, request(workInput)).Want(http.StatusOK)
	if worker.workPayload["planner_agent_id"] != agentID || len(worker.workPayload["execution_resources"].([]map[string]string)) != 1 || worker.workPayload["native_unit_ids"].([]string)[0] != childID {
		t.Fatal("feedback work did not use native role resources and child proofs")
	}
	planningTaskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": parentID, "status": "dispatched", "dispatched_at": testutil.Raw("now()")})
	planningTask, _ := h.Queries.GetAgentTask(ctx, parseUUID(planningTaskID))
	planningResponse, _, _, _, _, planningFailure := h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &planningTask, runtime, runtimeID, testWorkspaceID)
	if planningFailure != nil || planningResponse.EngineeringChain != "planning" || !strings.Contains(planningResponse.Agent.Instructions, "readonly feedback group") {
		t.Fatal("native feedback planning claim lost its scoped instructions")
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", planningTaskID)
	reportItem := engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: parentID, UserID: testUserID, AgentID: agentID, FeedbackBatchID: "019a0000-0000-7000-8000-000000000071", FeedbackGroupID: "report", ExpectedRevision: 1, ExpectedSequence: 2, Reason: "feedback_report_next"}
	if err := h.dispatchEngineeringContinuation(ctx, reportItem); err != nil {
		t.Fatal(err)
	}
	if worker.reportPayload["agent_id"] != agentID || worker.reportPayload["user_id"] != testUserID || worker.reportPayload["native_unit_ids"].([]string)[0] != childID {
		t.Fatal("report correction lost native principal/scope")
	}
	reportTaskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": parentID, "status": "dispatched", "dispatched_at": testutil.Raw("now()")})
	reportTask, _ := h.Queries.GetAgentTask(ctx, parseUUID(reportTaskID))
	reportResponse, _, _, _, _, reportFailure := h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &reportTask, runtime, runtimeID, testWorkspaceID)
	if reportFailure != nil || reportResponse.EngineeringChain != "review" || !strings.Contains(reportResponse.Agent.Instructions, "report expression correction") || strings.Contains(reportResponse.Agent.Instructions, "Plan only the group's") || strings.Contains(reportResponse.Agent.Instructions, "Missing or conflicting final/composed evidence must become a closure gap") {
		t.Fatalf("report correction claim escaped its expression boundary: %+v", reportFailure)
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", reportTaskID)
	verification := engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: parentID, UserID: testUserID, AgentID: verifierID, FeedbackBatchID: "019a0000-0000-7000-8000-000000000071", FeedbackGroupID: "group", FeedbackCommentID: commentID, ExpectedRevision: 1, ExpectedSequence: 3, Reason: "feedback_verify_next"}
	dbfx.Exec(t, "UPDATE issue SET status='todo' WHERE id=$1", childID)
	if err := h.dispatchEngineeringContinuation(ctx, verification); err == nil || worker.verify {
		t.Fatal("unaccepted native child admitted feedback verification")
	}
	dbfx.Exec(t, "UPDATE issue SET status='done' WHERE id=$1", childID)
	if err := h.dispatchEngineeringContinuation(ctx, verification); err != nil {
		t.Fatal(err)
	}
	if worker.verifyPayload["agent_id"] != verifierID || worker.verifyPayload["user_id"] != testUserID || worker.verifyPayload["comment_id"] != commentID || worker.verifyPayload["native_unit_ids"].([]string)[0] != childID {
		t.Fatal("feedback verification lost its frozen principal or native scope")
	}
	verifyTaskID := dbfx.Task(t, verifierID, testutil.Cols{"runtime_id": runtimeID, "issue_id": parentID, "status": "dispatched", "dispatched_at": testutil.Raw("now()")})
	verifyTask, _ := h.Queries.GetAgentTask(ctx, parseUUID(verifyTaskID))
	verifyResponse, _, _, _, _, verifyFailure := h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &verifyTask, runtime, runtimeID, testWorkspaceID)
	if verifyFailure != nil || verifyResponse.EngineeringChain != "feedback-verify" || !strings.Contains(verifyResponse.Agent.Instructions, "exactly the frozen comment") || strings.Contains(verifyResponse.Agent.Instructions, "Plan only the group's") {
		t.Fatalf("native feedback verifier claim lost its scope: %+v", verifyFailure)
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", verifyTaskID)
	item := engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: parentID, UserID: testUserID, AgentID: agentID, FeedbackBatchID: "019a0000-0000-7000-8000-000000000071", ExpectedSequence: 1}
	if err := h.restoreEngineeringFeedback(ctx, item); err == nil {
		t.Fatal("unresolved feedback allowed native Done")
	}
	worker.allow = true
	if err := h.restoreEngineeringFeedback(ctx, item); err != nil {
		t.Fatal(err)
	}
	if !worker.restored {
		t.Fatal("native restoration was not acknowledged")
	}
	parent, _ = h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: parseUUID(parentID), WorkspaceID: parseUUID(testWorkspaceID)})
	if parent.Status != "done" || uuidToString(parent.AssigneeID) != otherAssignee {
		t.Fatal("completed immediate feedback did not restore guarded Done")
	}
	worker.reopen = false
	testutil.Call(t, h.BeginEngineeringFeedback, request(payload)).Want(http.StatusOK)
	parent, _ = h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: parseUUID(parentID), WorkspaceID: parseUUID(testWorkspaceID)})
	if parent.Status != "done" {
		t.Fatal("retrying a completed capture reopened native Done")
	}
}

func TestEngineeringTeamFeedbackDerivesFrozenRolesAndAutomaticallyAuthorizesNativeForwardWork(t *testing.T) {
	for _, bug := range []bool{false, true} {
		t.Run(fmt.Sprintf("reproduction_%t", bug), func(t *testing.T) {
			ctx := context.Background()
			runtimeID := dbfx.Runtime(t, "Frozen Team Feedback runtime", testutil.Cols{"runtime_mode": "local", "daemon_id": "team-feedback-test"})
			triager := dbfx.Agent(t, "Frozen triager", runtimeID)
			verifier := dbfx.Agent(t, "Frozen feedback verifier", runtimeID)
			planner := dbfx.Agent(t, "Frozen feedback planner", runtimeID)
			reproducer := dbfx.Agent(t, "Frozen feedback reproducer", runtimeID)
			squad := createSquadAs(t, "", "Frozen Feedback Team", triager)
			projectID := dbfx.Project(t, "Team Feedback project")
			parentID := dbfx.Issue(t, "Frozen Team feedback", testutil.Cols{"project_id": projectID, "status": "done", "assignee_type": "squad", "assignee_id": squad.ID})
			planID := uuidToString(dbid.NewV7())
			metadata, _ := json.Marshal(map[string]any{"engineering.plan": planID, "engineering.unit": "unit", "engineering.revision": 1, "engineering.contract": strings.Repeat("b", 64)})
			childID := dbfx.Issue(t, "Accepted Team child", testutil.Cols{"project_id": projectID, "parent_issue_id": parentID, "status": "done", "metadata": json.RawMessage(metadata)})
			commentID := dbfx.Comment(t, parentID, "Actual native Team feedback")
			dbfx.Insert(t, "project_resource", testutil.Cols{"workspace_id": testWorkspaceID, "project_id": projectID, "resource_type": "local_directory", "resource_ref": json.RawMessage(`{"local_path":"/fixture/repository","daemon_id":"team-feedback-test","execution_mode":"in_place"}`)})
			policy := engineeringTeamFeedback{Triager: triager, Verifier: verifier, Planner: planner, Reproducer: reproducer}
			binding := &engineeringTeamBinding{IssueID: parentID, ProjectID: projectID, StartedBy: testUserID, Input: "Frozen Team feedback", Profile: engineeringTeamSnapshot{TeamID: squad.ID, WorkspaceID: testWorkspaceID, Revision: 1, Definition: engineeringTeamDefinition{Workflow: "develop", Feedback: &policy}}}
			worker := &nativeFeedbackFixture{requirementReviewFixture: requirementReviewFixture{units: []engineeringReviewUnit{{IssueID: childID, PlanDraftID: planID, UnitKey: "unit", ParentRevision: 1, ContractHash: strings.Repeat("b", 64)}}}, reopen: true, teamBinding: binding, teamScope: &engineeringTeamFeedbackScope{engineeringTeamFeedback: policy, UserID: testUserID, NeedsReproduction: bug, Revision: 1, Version: 3}}
			h := *testHandler
			h.EngineeringWorker = worker
			request := func(body any) *http.Request {
				return withURLParam(newRequest(http.MethodPost, "/feedback", body), "id", parentID)
			}
			input := map[string]any{"request_id": uuidToString(dbid.NewV7()), "expected_revision": 1, "expected_sequence": 25, "expected_batch_number": 0, "comment_ids": []string{commentID}}
			input["agent_id"] = triager
			testutil.Call(t, h.BeginEngineeringFeedback, request(input)).Want(http.StatusBadRequest)
			delete(input, "agent_id")
			testutil.Call(t, h.BeginEngineeringFeedback, request(input)).Want(http.StatusOK)
			if worker.payload["agent_id"] != triager || worker.payload["verifier_id"] != verifier || worker.payload["comments"].([]map[string]string)[0]["content"] != "Actual native Team feedback" {
				t.Fatal("Feedback did not retain Team roles and native comment facts")
			}
			batchID := "019a0000-0000-7000-8000-000000000071"
			item := engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: parentID, UserID: testUserID, AgentID: planner, ExpectedRevision: 1, ExpectedSequence: 3, FeedbackBatchID: batchID, Reason: "team_feedback_work"}
			if err := h.dispatchEngineeringContinuation(ctx, item); err != nil {
				t.Fatal(err)
			}
			if !worker.work || worker.workPayload["planner_agent_id"] != planner {
				t.Fatal("Team did not authorize its frozen forward planner")
			}
			if got, ok := worker.workPayload["reproduction_agent_id"]; ok != bug || bug && got != reproducer {
				t.Fatal("Team reproduction did not follow authoritative group scope")
			}
			if ids := worker.workPayload["native_unit_ids"].([]string); len(ids) != 1 || ids[0] != childID {
				t.Fatal("Team work lost native child scope")
			}
			worker.work = false
			changed := item
			changed.AgentID = verifier
			if err := h.dispatchEngineeringContinuation(ctx, changed); err == nil || worker.work {
				t.Fatal("Changed coordinator role bypassed frozen Team")
			}
			testutil.Call(t, h.AuthorizeEngineeringFeedbackWork, request(map[string]any{"batch_id": batchID, "expected_version": 3, "planner_agent_id": planner})).Want(http.StatusBadRequest)
			testutil.Call(t, h.AuthorizeEngineeringFeedbackWork, request(map[string]any{"batch_id": batchID, "expected_version": 3})).Want(http.StatusOK)
		})
	}
}
