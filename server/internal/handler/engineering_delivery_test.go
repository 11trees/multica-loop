package handler

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type managedDeliveryFixture struct {
	item                     engineeringContinuation
	taskID                   string
	unitIDs                  []string
	activations, acceptances int
	failAcceptance           bool
}

func (f *managedDeliveryFixture) Call(_ context.Context, input any) (json.RawMessage, error) {
	value := input.(map[string]any)
	var output any
	switch value["action"] {
	case "parent-scope":
		output = map[string]any{"managed": true, "parent_issue_id": f.item.ParentIssueID, "unit_issue_ids": f.unitIDs}
	case "activate-unit":
		f.activations++
		next := f.item
		next.TaskID = f.taskID
		next.Reason = "unit_ready"
		next.ExpectedRevision = 1
		next.ExpectedSequence = 0
		output = next
	case "prepare-run":
		output = map[string]string{"agent_id": f.item.AgentID}
	case "completion":
		output = map[string]any{"configured": true, "allowed": true, "binding": map[string]any{"workspaceId": f.item.WorkspaceID, "issueId": f.item.IssueID, "revision": 1, "contractVersion": "frozen-spec", "codeVersion": "0123456789abcdef0123456789abcdef01234567"}}
	case "accept-unit":
		f.acceptances++
		if f.failAcceptance {
			f.failAcceptance = false
			return nil, errors.New("acceptance unavailable")
		}
		output = map[string]bool{"accepted": true}
	default:
		return nil, errors.New("unexpected managed operation")
	}
	body, err := json.Marshal(output)
	return body, err
}

func TestEngineeringManagedUnitsWaitForSiblingRunsAndRecoverNativeCompletionBeforeAcceptance(t *testing.T) {
	ctx := context.Background()
	runtimeID := dbfx.Runtime(t, "Managed runtime", testutil.Cols{"runtime_mode": "local", "daemon_id": "managed-test"})
	agentID := dbfx.Agent(t, "Managed analyst", runtimeID)
	projectID := dbfx.Project(t, "Managed project")
	parentID := dbfx.Issue(t, "Managed requirement", testutil.Cols{"project_id": projectID})
	childID := dbfx.Issue(t, "Managed child", testutil.Cols{"parent_issue_id": parentID, "project_id": projectID})
	siblingID := dbfx.Issue(t, "Managed sibling", testutil.Cols{"parent_issue_id": parentID, "project_id": projectID})
	dbfx.Insert(t, "project_resource", testutil.Cols{"workspace_id": testWorkspaceID, "project_id": projectID, "resource_type": "local_directory", "resource_ref": json.RawMessage(`{"local_path":"/fixture/repo","daemon_id":"managed-test","execution_mode":"worktree"}`)})
	prior := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": siblingID, "status": "deferred"})
	target := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": childID, "status": "completed"})
	dbfx.Exec(t, "DELETE FROM agent_task_queue WHERE id=$1", target)
	h := *testHandler
	fixture := &managedDeliveryFixture{item: engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: childID, ParentIssueID: parentID, AgentID: agentID, UserID: testUserID, ExpectedRevision: 1, ExpectedSequence: 17, Reason: "unit_activation"}, taskID: target, unitIDs: []string{childID, siblingID}, failAcceptance: true}
	h.EngineeringWorker = fixture
	t.Cleanup(func() { testPool.Exec(context.Background(), "DELETE FROM agent_task_queue WHERE issue_id=$1", childID) })
	if err := h.dispatchEngineeringContinuation(ctx, fixture.item); err != nil {
		t.Fatal(err)
	}
	if fixture.activations != 0 {
		t.Fatal("deferred sibling was bypassed")
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", prior)
	if err := h.dispatchEngineeringContinuation(ctx, fixture.item); err != nil {
		t.Fatal(err)
	}
	task, err := h.Queries.GetAgentTask(ctx, parseUUID(target))
	if err != nil || task.Status != "queued" {
		t.Fatalf("managed unit was not queued: %v", err)
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", target)
	item := fixture.item
	item.Reason = "unit_passed"
	if err := h.dispatchEngineeringContinuation(ctx, item); err == nil {
		t.Fatal("lost acceptance acknowledgement was hidden")
	}
	child, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: parseUUID(childID), WorkspaceID: parseUUID(testWorkspaceID)})
	if err != nil || child.Status != "done" {
		t.Fatalf("native completion did not precede acknowledgement: %v", err)
	}
	if child.ParentIssueID != parseUUID(parentID) || child.ProjectID != parseUUID(projectID) {
		t.Fatal("native completion changed ownership")
	}
	if err := h.dispatchEngineeringContinuation(ctx, item); err != nil {
		t.Fatal(err)
	}
	if fixture.acceptances != 2 {
		t.Fatal("acceptance was not retried")
	}
	dbfx.Exec(t, "UPDATE issue SET status='cancelled' WHERE id=$1", parentID)
	if err := h.dispatchEngineeringContinuation(ctx, fixture.item); err == nil {
		t.Fatal("closed requirement allowed managed activation")
	}
}
