package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/multica-ai/multica/server/internal/testutil"
	"strconv"
	"testing"
)

func TestEngineeringTakeoverInspectsExactNativeClaimWithoutAcquiringFence(t *testing.T) {
	ctx := context.Background()
	runtime := dbfx.Runtime(t, "Takeover inspection", testutil.Cols{"runtime_mode": "local", "daemon_id": "takeover-fixture"})
	agent := dbfx.Agent(t, "Original agent", runtime)
	project := dbfx.Project(t, "Original project")
	issue := dbfx.Issue(t, "Original source", testutil.Cols{"project_id": project, "status": "todo"})
	dbfx.Insert(t, "project_resource", testutil.Cols{"project_id": project, "workspace_id": testWorkspaceID, "resource_type": "local_directory", "resource_ref": json.RawMessage(`{"local_path":"/fixture/original","daemon_id":"takeover-fixture","execution_mode":"worktree"}`)})
	task := dbfx.Task(t, agent, testutil.Cols{"runtime_id": runtime, "issue_id": issue, "status": "cancelled", "dispatched_at": testutil.Raw("now()"), "completed_at": testutil.Raw("now()")})
	native, err := testHandler.Queries.GetAgentTask(ctx, parseUUID(task))
	if err != nil {
		t.Fatal(err)
	}
	attempt := task + ":" + strconv.FormatInt(native.DispatchedAt.Time.UnixMicro(), 10)
	request := map[string]any{"claim": map[string]any{"caseId": "REPAIR-original"}, "case_id": "REPAIR-original", "workspace_id": testWorkspaceID, "issue_id": issue, "observation_id": "original", "snapshot_hash": "hash", "source_attempt_id": attempt}
	source := map[string]any{"workspace_id": testWorkspaceID, "issue_id": issue, "agent_id": agent, "attempt_id": attempt, "case_id": "REPAIR-original", "observation_id": "original", "snapshot_hash": "hash", "registered_repository_path": "/fixture/original", "execution_repository_path": "/fixture/removed-worktree", "mode": "worktree", "receipt_hash": "receipt", "code_version": "original", "kernel_version": "original-kernel", "host_version": "original-host"}
	h := *testHandler
	inspections := 0
	h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		switch input["action"] {
		case "takeover-pending":
			return json.Marshal([]any{request})
		case "takeover-inspected":
			inspections++
			payload := input["payload"].(map[string]any)
			if payload["project_id"] != project || payload["runtime_id"] != runtime || payload["execution_repository_path"] != "/fixture/removed-worktree" {
				t.Fatal("native inspection changed source")
			}
			return json.RawMessage(`{}`), nil
		}
		return nil, fmt.Errorf("unexpected action")
	}}
	h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["action"] != "repair-source" {
			t.Fatal("unexpected business action")
		}
		return json.Marshal(source)
	}}
	authority := engineeringAdminAuthority{OwnerID: "fixture", Token: 1}
	if err = h.ReconcileEngineeringTakeovers(ctx, authority); err != nil {
		t.Fatal(err)
	}
	if inspections != 1 {
		t.Fatal("source not inspected")
	}
	for key, wrong := range map[string]string{"attempt_id": task + ":0", "workspace_id": testUserID, "case_id": "REPAIR-other", "registered_repository_path": "/invented", "mode": "in_place"} {
		old := source[key]
		source[key] = wrong
		if err = h.ReconcileEngineeringTakeovers(ctx, authority); err == nil {
			t.Fatalf("accepted changed %s", key)
		}
		source[key] = old
	}
	if inspections != 1 {
		t.Fatal("invalid source reached management inspection")
	}
	var count int
	if err = testPool.QueryRow(ctx, "SELECT count(*) FROM engineering_repair_fence WHERE project_id=$1", project).Scan(&count); err != nil || count != 0 {
		t.Fatal("inspection granted a fence", err)
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET dispatched_at=dispatched_at+interval '1 second' WHERE id=$1", task)
	if err = h.ReconcileEngineeringTakeovers(ctx, authority); err == nil {
		t.Fatal("accepted superseded native dispatch")
	}
}
