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

type requirementReviewFixture struct {
	units        []engineeringReviewUnit
	acknowledged bool
	configured   int
}

func (f *requirementReviewFixture) Call(_ context.Context, input any) (json.RawMessage, error) {
	value := input.(map[string]any)
	var result any
	switch value["action"] {
	case "review-inputs":
		result = map[string]any{"review_units": f.units}
	case "parent-scope":
		result = map[string]any{"managed": false, "review_units": f.units}
	case "configure-review":
		f.configured++
		result = map[string]bool{"configured": true}
	case "selection":
		result = map[string]any{"configured": true, "chain": "review", "repository_path": "/fixture/repository", "code_version": strings.Repeat("a", 40), "review_units": f.units}
	case "review-ack":
		f.acknowledged = true
		result = map[string]bool{"acknowledged": true}
	case "completion":
		result = map[string]any{"configured": true, "allowed": f.acknowledged, "review_units": f.units}
	default:
		return nil, fmt.Errorf("unexpected review operation: %s", value["action"])
	}
	body, err := json.Marshal(result)
	return body, err
}

func TestEngineeringRequirementReviewChecksNativeOriginRunsAndAuthenticatedReading(t *testing.T) {
	ctx := context.Background()
	runtimeID := dbfx.Runtime(t, "Requirement reviewer", testutil.Cols{"runtime_mode": "local", "daemon_id": "review-test"})
	agentID := dbfx.Agent(t, "Review agent", runtimeID)
	projectID := dbfx.Project(t, "Review project")
	parentID := dbfx.Issue(t, "Final requirement", testutil.Cols{"project_id": projectID})
	planID := uuidToString(dbid.NewV7())
	metadata, _ := json.Marshal(map[string]any{"engineering.plan": planID, "engineering.unit": "unit", "engineering.revision": 1, "engineering.contract": strings.Repeat("b", 64)})
	childID := dbfx.Issue(t, "Verified child", testutil.Cols{"project_id": projectID, "parent_issue_id": parentID, "status": "done", "metadata": json.RawMessage(metadata)})
	dbfx.Insert(t, "project_resource", testutil.Cols{"workspace_id": testWorkspaceID, "project_id": projectID, "resource_type": "local_directory", "resource_ref": json.RawMessage(`{"local_path":"/fixture/repository","daemon_id":"review-test","execution_mode":"in_place"}`)})
	h := *testHandler
	worker := &requirementReviewFixture{units: []engineeringReviewUnit{{IssueID: childID, PlanDraftID: planID, UnitKey: "unit", ParentRevision: 1, ContractHash: strings.Repeat("b", 64)}}}
	h.EngineeringWorker = worker
	request := func(path string, body any) *http.Request {
		return withURLParam(newRequest(http.MethodPost, "/api/issues/"+parentID+"/engineering/"+path, body), "id", parentID)
	}
	configure := func() {
		testutil.Call(t, h.ConfigureEngineeringReview, request("review", map[string]any{"expected_revision": 1, "expected_sequence": 17, "agent_id": agentID})).Want(http.StatusOK)
	}
	configure()
	if worker.configured != 1 {
		t.Fatal("review was not configured")
	}
	prior := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": childID, "status": "deferred"})
	testutil.Call(t, h.ConfigureEngineeringReview, request("review", map[string]any{"expected_revision": 1, "expected_sequence": 17, "agent_id": agentID})).Want(http.StatusConflict)
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", prior)
	taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": parentID, "status": "dispatched", "dispatched_at": testutil.Raw("now()")})
	task, _ := h.Queries.GetAgentTask(ctx, parseUUID(taskID))
	runtime, _ := h.Queries.GetAgentRuntime(ctx, parseUUID(runtimeID))
	response, _, _, _, _, failure := h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &task, runtime, runtimeID, testWorkspaceID)
	if failure != nil || response.EngineeringChain != "review" || !strings.Contains(response.Agent.Instructions, "Do not run tests") {
		t.Fatalf("review claim did not preserve role and evidence boundary: %+v", failure)
	}
	ack := map[string]any{"expected_revision": 1, "expected_sequence": 25, "report_hash": strings.Repeat("c", 64)}
	testutil.Call(t, h.AcknowledgeEngineeringReview, request("review/acknowledge", ack)).Want(http.StatusConflict)
	if worker.acknowledged {
		t.Fatal("unfinished native root run allowed report acknowledgement")
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", taskID)
	testutil.Call(t, h.AcknowledgeEngineeringReview, request("review/acknowledge", ack)).Want(http.StatusOK)
	parent, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: parseUUID(parentID), WorkspaceID: parseUUID(testWorkspaceID)})
	if err != nil || parent.Status != "done" || parent.ProjectID != parseUUID(projectID) {
		t.Fatalf("reading did not close the unchanged requirement: %v", err)
	}
	testutil.Call(t, h.AcknowledgeEngineeringReview, request("review/acknowledge", ack)).Want(http.StatusOK)
	params := db.UpdateIssueParams{ID: parent.ID, ProjectID: parent.ProjectID, Status: pgtype.Text{String: "done", Valid: true}}
	dbfx.Exec(t, "UPDATE issue SET status='todo' WHERE id=$1", childID)
	if err := h.requireEngineeringCompletion(ctx, parent.WorkspaceID, params); err == nil {
		t.Fatal("protocol acceptance bypassed reopened native child")
	}
	dbfx.Exec(t, "UPDATE issue SET status='done',metadata='{}' WHERE id=$1", childID)
	if err := h.requireEngineeringCompletion(ctx, parent.WorkspaceID, params); err == nil {
		t.Fatal("native child with changed origin authorized closure")
	}
}
