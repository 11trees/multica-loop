package handler

import (
	"context"
	"errors"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestEngineeringTeamChildDoneWakeupPreservesWorkflowOwnership(t *testing.T) {
	for _, mode := range []string{"workflow", "ordinary", "routing unavailable"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			runtime := dbfx.Runtime(t, "Child completion runtime")
			leader := dbfx.Agent(t, "Child completion leader", runtime)
			team := createSquadAs(t, "", "Child completion Team", leader)
			parent := dbfx.Issue(t, "Child completion parent", testutil.Cols{"status": "todo", "assignee_type": "squad", "assignee_id": team.ID})
			child := dbfx.Issue(t, "Child completion unit", testutil.Cols{"status": "in_progress", "parent_issue_id": parent})
			dbfx.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", parent)
			dbfx.Cleanup(t, "DELETE FROM issue_child_event WHERE parent_id=$1", parent)
			tasks := *testHandler.TaskService
			checks := 0
			tasks.EngineeringTeamOwnsIssue = func(_ context.Context, issue db.Issue) (bool, error) {
				if uuidToString(issue.ID) != parent {
					return false, nil
				}
				checks++
				if mode == "routing unavailable" {
					return false, errors.New("fixture Team routing unavailable")
				}
				return mode == "workflow", nil
			}
			wakeups := service.IssueWakeupService{Tasks: &tasks}
			if err := wakeups.ProcessChildEvents(ctx, parseUUID(parent)); err != nil {
				t.Fatal(err)
			}
			dbfx.Exec(t, "UPDATE issue SET status='done' WHERE id=$1", child)
			if err := wakeups.ProcessChildEvents(ctx, parseUUID(parent)); err != nil {
				t.Fatal(err)
			}
			var runs, pending int
			if err := testPool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", parent).Scan(&runs); err != nil {
				t.Fatal(err)
			}
			wantRuns := 0
			if mode == "ordinary" {
				wantRuns = 1
			}
			if runs != wantRuns || checks == 0 {
				t.Fatalf("child completion bypassed workflow ownership: runs=%d want=%d checks=%d", runs, wantRuns, checks)
			}
			if err := testPool.QueryRow(ctx, `SELECT count(*) FROM issue_wakeup_receipt r JOIN issue_wakeup w ON w.id=r.wakeup_id WHERE w.issue_id=$1 AND r.processed_at IS NULL`, parent).Scan(&pending); err != nil {
				t.Fatal(err)
			}
			if mode == "routing unavailable" {
				if pending == 0 {
					t.Fatal("unavailable routing discarded the child completion facts")
				}
			} else if pending != 0 {
				t.Fatal("handled child completion facts remain pending", pending)
			}
			if mode == "workflow" {
				var recorded bool
				if err := testPool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM activity_log WHERE issue_id=$1 AND action='wakeup_triggered' AND details->>'reason'='team_workflow' AND details->>'total'='1')`, parent).Scan(&recorded); err != nil || !recorded {
					t.Fatal("workflow-owned child completion facts were not retained in the timeline", err)
				}
			}
		})
	}
}
