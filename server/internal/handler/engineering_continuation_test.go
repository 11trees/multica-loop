package handler

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type engineeringCoordinatorFixture struct {
	item     engineeringContinuation
	prepares int
	recovery *service.EngineeringRecoveryExecution
}

func (s *engineeringCoordinatorFixture) Call(_ context.Context, input any) (json.RawMessage, error) {
	value := input.(map[string]any)
	if value["action"] == "team-routing" {
		return json.RawMessage(`{"owned":false,"binding":null,"profile":null}`), nil
	}
	if value["action"] == "continuations" {
		body, err := json.Marshal([]engineeringContinuation{s.item})
		return body, err
	}
	s.prepares++
	body, err := json.Marshal(map[string]any{"agent_id": s.item.AgentID, "recovery_execution": s.recovery})
	return body, err
}

func TestEngineeringContinuationWaitsForPriorRunAndDoesNotRepeatTerminalDispatch(t *testing.T) {
	for _, reason := range []string{"business_ready", "human_answers", "reproduction_handoff", "repair_human_answers"} {
		t.Run(reason, func(t *testing.T) {
			runtimeID := dbfx.Runtime(t, "Engineering continuation runtime", testutil.Cols{"runtime_mode": "local", "daemon_id": "engineering-continuation"})
			agentID := dbfx.Agent(t, "Engineering continuation verifier", runtimeID)
			projectID := dbfx.Project(t, "Engineering continuation project")
			issueID := dbfx.Issue(t, "Engineering continuation issue", testutil.Cols{"project_id": projectID, "status": "todo"})
			dbfx.Insert(t, "project_resource", testutil.Cols{"project_id": projectID, "workspace_id": testWorkspaceID, "resource_type": "local_directory", "resource_ref": json.RawMessage(`{"local_path":"/fixture/repo","daemon_id":"engineering-continuation","execution_mode":"in_place"}`)})
			priorTask := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "running"})
			targetID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "completed"})
			dbfx.Exec(t, `DELETE FROM agent_task_queue WHERE id=$1`, targetID)
			h := *testHandler
			worker := &engineeringCoordinatorFixture{item: engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: issueID, AgentID: agentID, UserID: testUserID, TaskID: targetID, ExpectedRevision: 1, ExpectedSequence: 8, Reason: strings.TrimPrefix(reason, "repair_")}}

			if reason == "repair_human_answers" {
				draftID := "repaired-stage"
				worker.recovery = &service.EngineeringRecoveryExecution{Kind: "continuation", TargetHash: strings.Repeat("a", 64), ApplicationHash: strings.Repeat("b", 64), ReadyHash: strings.Repeat("c", 64), EntryTaskID: priorTask, WorkspaceID: testWorkspaceID, IssueID: issueID, AgentID: agentID, UserID: testUserID, DraftID: &draftID, Revision: 1, Sequence: 8}
				worker.recovery.Hash = worker.recovery.Digest()
			}
			h.EngineeringWorker = worker
			t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id=$1`, issueID) })
			if err := h.ReconcileEngineering(context.Background()); err != nil {
				t.Fatal(err)
			}
			if worker.prepares != 0 {
				t.Fatal("an active prior task was bypassed")
			}
			dbfx.Exec(t, `UPDATE agent_task_queue SET status='deferred' WHERE id=$1`, priorTask)
			if err := h.ReconcileEngineering(context.Background()); err != nil {
				t.Fatal(err)
			}
			if worker.prepares != 0 {
				t.Fatal("a deferred prior task was bypassed")
			}
			dbfx.Exec(t, `UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1`, priorTask)
			if err := h.ReconcileEngineering(context.Background()); err != nil {
				t.Fatal(err)
			}
			task, err := h.Queries.GetAgentTask(context.Background(), parseUUID(targetID))
			if err != nil {
				t.Fatal(err)
			}
			if task.Status != "queued" || uuidToString(task.AgentID) != agentID || uuidToString(task.OriginatorUserID) != testUserID {
				t.Fatalf("wrong continuation: %+v", task)
			}
			hint, e := service.EngineeringRecoveryFromContext(task.Context)
			if e != nil {
				t.Fatal(e)
			}
			if reason == "repair_human_answers" {
				if hint == nil || hint.Hash != worker.recovery.Hash {
					t.Fatal("native queue lost recovery continuation")
				}
				issue, e := h.Queries.GetIssueInWorkspace(context.Background(), db.GetIssueInWorkspaceParams{WorkspaceID: parseUUID(testWorkspaceID), ID: parseUUID(issueID)})
				if e != nil {
					t.Fatal(e)
				}
				if _, e = h.TaskService.EnqueueEngineeringContinuation(context.Background(), issue, parseUUID(agentID), parseUUID(testUserID), parseUUID(targetID), "retry", hint); e != nil {
					t.Fatal(e)
				}
				if _, e = h.TaskService.EnqueueEngineeringContinuation(context.Background(), issue, parseUUID(agentID), parseUUID(testUserID), parseUUID(targetID), "changed"); e == nil {
					t.Fatal("stable continuation discarded recovery identity")
				}
			} else if hint != nil {
				t.Fatal("ordinary continuation gained recovery authority")
			}
			if worker.prepares != 1 {
				t.Fatal("continuation was not revalidated")
			}
			dbfx.Exec(t, `UPDATE agent_task_queue SET status='failed',completed_at=now() WHERE id=$1`, targetID)
			for range 2 {
				if err := h.ReconcileEngineering(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			var count int
			dbfx.QueryRow(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1`, issueID).Scan(&count)
			if count != 2 || worker.prepares != 1 {
				t.Fatalf("terminal continuation retried automatically: tasks=%d prepares=%d", count, worker.prepares)
			}

		})
	}
}

func TestEngineeringContinuationRechecksInvocationAndLifecycle(t *testing.T) {
	for _, state := range []string{"archived_agent", "private_agent", "former_member", "closed_issue", "triage"} {
		t.Run(state, func(t *testing.T) {
			runtimeID := dbfx.Runtime(t, "Unavailable engineering runtime")
			agentID := dbfx.Agent(t, "Unavailable engineering agent", runtimeID)
			issueID := dbfx.Issue(t, "Unavailable engineering issue", testutil.Cols{"status": "todo"})
			targetID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "completed"})
			dbfx.Exec(t, `DELETE FROM agent_task_queue WHERE id=$1`, targetID)
			principal := testUserID
			switch state {
			case "archived_agent":
				dbfx.Exec(t, `UPDATE agent SET archived_at=now() WHERE id=$1`, agentID)
			case "private_agent":
				other := dbfx.User(t, "Other engineering owner", agentID+"@example.invalid")
				dbfx.Exec(t, `UPDATE agent SET permission_mode='private',owner_id=$2 WHERE id=$1`, agentID, other)
			case "former_member":
				principal = dbfx.User(t, "Former engineering member", agentID+"@example.invalid")
			case "closed_issue":
				dbfx.Exec(t, `UPDATE issue SET status='cancelled' WHERE id=$1`, issueID)
			case "triage":
				dbfx.Exec(t, `UPDATE issue SET triage_state='pending' WHERE id=$1`, issueID)
			}
			worker := &engineeringCoordinatorFixture{item: engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: issueID, AgentID: agentID, UserID: principal, TaskID: targetID, ExpectedRevision: 1, Reason: "development_handoff"}}
			h := *testHandler
			h.EngineeringWorker = worker
			err := h.ReconcileEngineering(context.Background())
			if (state == "archived_agent" || state == "private_agent") && (err == nil || !strings.Contains(err.Error(), "no longer invocable")) {
				t.Fatalf("unavailable agent was not rejected: %v", err)
			}
			if state == "former_member" && err == nil {
				t.Fatal("former member remained authorized")
			}
			if (state == "closed_issue" || state == "triage") && err != nil {
				t.Fatalf("terminal/triage issue was not skipped: %v", err)
			}
			var count int
			dbfx.QueryRow(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1`, issueID).Scan(&count)
			if count != 0 || worker.prepares != 0 {
				t.Fatal("an unavailable continuation was prepared or enqueued")
			}
		})
	}
}
