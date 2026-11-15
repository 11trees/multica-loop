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

func TestEngineeringTakeoverControlUsesNativeCancellationAndRetainsCleanupBarrier(t *testing.T) {
	ctx := context.Background()
	f := newControllerFixture(t)
	f.begin(t)
	task := mustControllerTask(t, f)
	chat := dbfx.ChatSession(t, uuidToString(task.AgentID), testutil.Cols{"project_id": f.project})
	chatTask := dbfx.Task(t, uuidToString(task.AgentID), testutil.Cols{"runtime_id": uuidToString(task.RuntimeID), "chat_session_id": chat, "status": "queued"})
	otherIssue := dbfx.Issue(t, "Unrelated active issue")
	otherTask := dbfx.Task(t, uuidToString(task.AgentID), testutil.Cols{"runtime_id": uuidToString(task.RuntimeID), "issue_id": otherIssue, "status": "queued"})
	attempt := f.task + ":" + strconv.FormatInt(task.DispatchedAt.Time.UnixMicro(), 10)
	claim := map[string]any{"caseId": "fixture-case", "attemptId": "fixture-attempt", "generation": 1, "sessionId": "fixture-session", "authority": map[string]any{"ownerId": "fixture-owner", "token": 1}}
	current := map[string]any{"intent_revision": 1, "request": map[string]any{"case_id": "fixture-case", "workspace_id": testWorkspaceID, "issue_id": f.issue, "observation_id": "fixture-observation", "snapshot_hash": "fixture-hash", "source_attempt_id": attempt, "claim": claim, "inspection": map[string]any{"project_id": f.project, "runtime_id": uuidToString(task.RuntimeID), "registered_repository_path": "/fixture"}}}
	revoked := false
	f.h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["action"] != "takeover-current" {
			t.Fatal("unexpected authority operation")
		}
		if revoked {
			return nil, fmt.Errorf("authority revoked")
		}
		return json.Marshal(current)
	}}
	f.h.EngineeringWorker = &engineeringRecorder{response: json.RawMessage(`{}`)}
	body, _ := json.Marshal(map[string]any{"claim": claim})
	result, err := f.h.DrainEngineeringProject(ctx, body)
	if err != nil || result.(map[string]any)["fence_required"] != true {
		t.Fatal(result, err)
	}
	f.fence(t)
	dbfx.Exec(t, "UPDATE engineering_repair_fence SET source_attempt_id=$1 WHERE project_id=$2", attempt, f.project)
	dbfx.Exec(t, "UPDATE engineering_repair_fence SET generation=2 WHERE project_id=$1", f.project)
	if _, err = f.h.DrainEngineeringProject(ctx, body); err == nil {
		t.Fatal("accepted foreign fence generation")
	}
	if mustControllerTask(t, f).Status != "running" {
		t.Fatal("rejected drain changed native task")
	}
	dbfx.Exec(t, "UPDATE engineering_repair_fence SET generation=1 WHERE project_id=$1", f.project)
	result, err = f.h.DrainEngineeringProject(ctx, body)
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["cancelled"] != 2 || result.(map[string]any)["unfinished_controllers"] != 1 || result.(map[string]any)["phase"] != "draining" {
		t.Fatalf("cancellation invented physical cleanup: %v", result)
	}
	if mustControllerTask(t, f).Status != "cancelled" {
		t.Fatal("native task was not cancelled")
	}
	chatRow, err := f.h.Queries.GetAgentTask(ctx, parseUUID(chatTask))
	if err != nil || chatRow.Status != "cancelled" {
		t.Fatal("project chat was not cancelled", err)
	}
	otherRow, err := f.h.Queries.GetAgentTask(ctx, parseUUID(otherTask))
	if err != nil || otherRow.Status != "queued" {
		t.Fatal("drain escaped the fenced project", err)
	}
	revoked = true
	if _, err = f.h.DrainEngineeringProject(ctx, body); err == nil {
		t.Fatal("revoked management invoked cancellation")
	}
}
