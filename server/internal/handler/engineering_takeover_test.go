package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
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
			if source["execution_binding_origin"] != nil && (payload["execution_binding_origin"] != source["execution_binding_origin"] || payload["execution_source_attempt_id"] != source["execution_source_attempt_id"]) {
				t.Fatal("prepared source inspection discarded retained binding provenance")
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
	source["execution_binding_origin"] = "retained-preparation"
	source["execution_source_attempt_id"] = "retained-original:123"
	if err = h.ReconcileEngineeringTakeovers(ctx, authority); err != nil {
		t.Fatal(err)
	}
	delete(source, "execution_binding_origin")
	delete(source, "execution_source_attempt_id")
	for key, wrong := range map[string]string{"attempt_id": task + ":0", "workspace_id": testUserID, "case_id": "REPAIR-other", "registered_repository_path": "/invented", "mode": "in_place"} {
		old := source[key]
		source[key] = wrong
		if err = h.ReconcileEngineeringTakeovers(ctx, authority); err == nil {
			t.Fatalf("accepted changed %s", key)
		}
		source[key] = old
	}
	if inspections != 2 {
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

type takeoverControlFixture struct {
	controllerFixture
	body    json.RawMessage
	source  map[string]any
	current map[string]any
}

func newTakeoverControlFixture(t *testing.T) takeoverControlFixture {
	t.Helper()
	f := newControllerFixture(t)
	f.begin(t)
	task := mustControllerTask(t, f)
	dbfx.Exec(t, "UPDATE agent_runtime SET runtime_mode='local',daemon_id='takeover-control-fixture' WHERE id=$1", uuidToString(task.RuntimeID))
	dbfx.Insert(t, "project_resource", testutil.Cols{"project_id": f.project, "workspace_id": testWorkspaceID, "resource_type": "local_directory", "resource_ref": json.RawMessage(`{"local_path":"/fixture","daemon_id":"takeover-control-fixture","execution_mode":"in_place"}`)})
	attempt := f.task + ":" + strconv.FormatInt(task.DispatchedAt.Time.UnixMicro(), 10)
	claim := map[string]any{"caseId": "fixture-case", "attemptId": "fixture-attempt", "generation": 1, "sessionId": "fixture-session", "authority": map[string]any{"ownerId": "fixture-owner", "token": 1}}
	inspection := map[string]any{"project_id": f.project, "runtime_id": uuidToString(task.RuntimeID), "registered_repository_path": "/fixture", "execution_repository_path": "/fixture", "mode": "in_place", "receipt_hash": "receipt", "code_version": "original-code", "kernel_version": "original-kernel", "host_version": "original-api"}
	current := map[string]any{"intent_revision": 1, "request": map[string]any{"case_id": "fixture-case", "workspace_id": testWorkspaceID, "issue_id": f.issue, "observation_id": "fixture-observation", "snapshot_hash": "fixture-hash", "source_attempt_id": attempt, "claim": claim, "inspection": inspection}}
	source := map[string]any{"workspace_id": testWorkspaceID, "issue_id": f.issue, "agent_id": uuidToString(task.AgentID), "attempt_id": attempt, "case_id": "fixture-case", "observation_id": "fixture-observation", "snapshot_hash": "fixture-hash", "registered_repository_path": "/fixture", "execution_repository_path": "/fixture", "mode": "in_place", "receipt_hash": "receipt", "code_version": "original-code", "kernel_version": "original-kernel", "host_version": "original-api", "revision": 1, "sequence": 7}
	f.h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["action"] != "takeover-current" {
			t.Fatal("unexpected authority action")
		}
		return json.Marshal(current)
	}}
	f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["action"] != "repair-source" {
			t.Fatal("unexpected source action")
		}
		return json.Marshal(source)
	}}
	body, _ := json.Marshal(map[string]any{"claim": claim})
	return takeoverControlFixture{f, body, source, current}
}
func TestEngineeringTakeoverControlUsesNativeCancellationAndRetainsCleanupBarrier(t *testing.T) {
	ctx := context.Background()
	f := newTakeoverControlFixture(t)
	task := mustControllerTask(t, f.controllerFixture)
	chat := dbfx.ChatSession(t, uuidToString(task.AgentID), testutil.Cols{"project_id": f.project})
	chatTask := dbfx.Task(t, uuidToString(task.AgentID), testutil.Cols{"runtime_id": uuidToString(task.RuntimeID), "chat_session_id": chat, "status": "queued"})
	otherIssue := dbfx.Issue(t, "Unrelated active issue")
	otherTask := dbfx.Task(t, uuidToString(task.AgentID), testutil.Cols{"runtime_id": uuidToString(task.RuntimeID), "issue_id": otherIssue, "status": "queued"})
	result, err := f.h.DrainEngineeringProject(ctx, f.body)
	if err != nil {
		t.Fatal(err)
	}
	if result.(engineeringRepairProgress).Cancelled != 2 || result.(engineeringRepairProgress).UnfinishedControllers != 1 || result.(engineeringRepairProgress).Phase != "draining" {
		t.Fatalf("cancellation invented physical cleanup: %v", result)
	}
	if mustControllerTask(t, f.controllerFixture).Status != "cancelled" {
		t.Fatal("native task not cancelled")
	}
	chatRow, err := f.h.Queries.GetAgentTask(ctx, parseUUID(chatTask))
	if err != nil || chatRow.Status != "cancelled" {
		t.Fatal("project chat not cancelled", err)
	}
	otherRow, err := f.h.Queries.GetAgentTask(ctx, parseUUID(otherTask))
	if err != nil || otherRow.Status != "queued" {
		t.Fatal("escaped fenced project", err)
	}
	fence, err := f.h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)})
	if err != nil || fence.SourceRevision != 1 || fence.SnapshotHash != "fixture-hash" {
		t.Fatal("lost original source version", err)
	}
	if _, err = f.h.DrainEngineeringProject(ctx, f.body); err != nil {
		t.Fatal("identical takeover not replayable", err)
	}
	dbfx.Exec(t, "UPDATE engineering_repair_fence SET generation=2 WHERE project_id=$1", f.project)
	if _, err = f.h.DrainEngineeringProject(ctx, f.body); err == nil {
		t.Fatal("accepted foreign fence generation")
	}
}
func TestEngineeringTakeoverRevocationAfterCommitRetainsFenceWithoutCancelling(t *testing.T) {
	ctx := context.Background()
	f := newTakeoverControlFixture(t)
	reads := 0
	f.h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		reads++
		if reads >= 3 {
			return nil, fmt.Errorf("management intent revoked")
		}
		return json.Marshal(f.current)
	}}
	if _, err := f.h.DrainEngineeringProject(ctx, f.body); err == nil {
		t.Fatal("revoked management continued")
	}
	fence, err := f.h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)})
	if err != nil || fence.Phase != "draining" {
		t.Fatal("lost committed fence", err)
	}
	if mustControllerTask(t, f.controllerFixture).Status != "running" {
		t.Fatal("cancelled after revocation")
	}
}
func TestEngineeringTakeoverRejectsChangedOriginalBeforeAnyFence(t *testing.T) {
	ctx := context.Background()
	f := newTakeoverControlFixture(t)
	for key, wrong := range map[string]any{"revision": 0, "receipt_hash": "replacement", "host_version": "new-api", "kernel_version": "new-kernel", "code_version": "different-code", "execution_repository_path": "/invented", "execution_binding_origin": "retained-preparation", "execution_source_attempt_id": "changed-source:123"} {
		old := f.source[key]
		f.source[key] = wrong
		if _, err := f.h.DrainEngineeringProject(ctx, f.body); err == nil {
			t.Fatalf("accepted changed %s", key)
		}
		f.source[key] = old
	}
	var count int
	if err := testPool.QueryRow(ctx, "SELECT count(*) FROM engineering_repair_fence WHERE project_id=$1", f.project).Scan(&count); err != nil || count != 0 {
		t.Fatal("invalid source acquired fence", err)
	}
	if mustControllerTask(t, f.controllerFixture).Status != "running" {
		t.Fatal("invalid source cancelled task")
	}
}

func TestEngineeringTakeoverRevalidatesSourceAfterWaitingForProjectLock(t *testing.T) {
	ctx := context.Background()
	f := newTakeoverControlFixture(t)
	hold, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer hold.Rollback(ctx)
	if _, err = hold.Exec(ctx, "SELECT id FROM project WHERE id=$1 FOR UPDATE", f.project); err != nil {
		t.Fatal(err)
	}
	var holder int
	if err = hold.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&holder); err != nil {
		t.Fatal(err)
	}
	var changed atomic.Bool
	f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		copy := map[string]any{}
		for key, value := range f.source {
			copy[key] = value
		}
		if changed.Load() {
			copy["revision"] = 2
		}
		return json.Marshal(copy)
	}}
	done := make(chan error, 1)
	go func() { _, err := f.h.DrainEngineeringProject(ctx, f.body); done <- err }()
	deadline := time.Now().Add(3 * time.Second)
	blocked := false
	for time.Now().Before(deadline) {
		var count int
		if err = testPool.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", holder).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			blocked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("takeover never waited for the held project row")
	}
	changed.Store(true)
	if err = hold.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err == nil {
			t.Fatal("accepted source version changed during admission wait")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("takeover did not finish after lock release")
	}
	var count int
	if err = testPool.QueryRow(ctx, "SELECT count(*) FROM engineering_repair_fence WHERE project_id=$1", f.project).Scan(&count); err != nil || count != 0 {
		t.Fatal("changed source committed fence", err)
	}
	if mustControllerTask(t, f.controllerFixture).Status != "running" {
		t.Fatal("changed source was cancelled")
	}
}

func TestEngineeringTakeoverSuccessorRequiresConfirmedPredecessorExit(t *testing.T) {
	ctx := context.Background()
	f := newTakeoverControlFixture(t)
	var input struct {
		Claim json.RawMessage `json:"claim"`
	}
	if err := json.Unmarshal(f.body, &input); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.acquireEngineeringRepairFence(ctx, input.Claim); err != nil {
		t.Fatal(err)
	}
	request := f.current["request"].(map[string]any)
	claim := request["claim"].(map[string]any)
	claim["generation"] = 2
	claim["attemptId"] = "successor-attempt"
	body, _ := json.Marshal(map[string]any{"claim": claim})
	stopped := false
	f.h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["action"] == "takeover-predecessor" {
			if input["attempt_id"] != "fixture-attempt" {
				t.Fatal("wrong physical predecessor")
			}
			return json.Marshal(map[string]bool{"stopped": stopped})
		}
		return json.Marshal(f.current)
	}}
	if _, err := f.h.DrainEngineeringProject(ctx, body); err == nil {
		t.Fatal("replaced uncertain previous invocation")
	}
	fence, err := f.h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)})
	if err != nil || fence.Generation != 1 {
		t.Fatal("unconfirmed handover changed fence", err)
	}
	if mustControllerTask(t, f.controllerFixture).Status != "running" {
		t.Fatal("unconfirmed successor cancelled task")
	}
	stopped = true
	if _, err = f.h.DrainEngineeringProject(ctx, body); err != nil {
		t.Fatal(err)
	}
	fence, err = f.h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)})
	if err != nil || fence.Generation != 2 || fence.AttemptID != "successor-attempt" || fence.SourceRevision != 1 || fence.SnapshotHash != "fixture-hash" {
		t.Fatal("lost original source during handover", err)
	}
}

func TestEngineeringRepairWorkspaceVersionRechecksOwnedSourceBeforePersistence(t *testing.T) {
	root := "/fixture/source"
	initial := engineeringRepairProgress{Phase: "owned", WorkspaceRoot: &root, TargetsHash: strings.Repeat("a", 64), SourceAttemptID: "original:123", SnapshotHash: "original-snapshot"}
	for _, change := range []string{"none", "cohort", "draining", "source", "revoked"} {
		t.Run(change, func(t *testing.T) {
			h := *testHandler
			writes, checks := 0, 0
			h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				if input["action"] != "repair-workspace-version" {
					t.Fatal("unexpected business action")
				}
				payload := input["payload"].(map[string]string)
				if payload["case_id"] != "original-case" || payload["snapshot_hash"] != initial.SnapshotHash {
					t.Fatal("version did not pin original source")
				}
				source := initial.SourceAttemptID
				if change == "source" {
					source = "foreign:456"
				}
				return json.Marshal(map[string]string{"source_attempt_id": source, "snapshot_hash": initial.SnapshotHash, "workspace_root": root, "workspace_version": "workspace-content-v1:" + strings.Repeat("b", 40) + ":" + strings.Repeat("c", 64)})
			}}
			h.EngineeringTakeoverControl = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				checks++
				if change == "revoked" {
					return nil, fmt.Errorf("original authority revoked")
				}
				current := initial
				if change == "cohort" {
					current.TargetsHash = strings.Repeat("d", 64)
				}
				if change == "draining" {
					current.Phase = "draining"
				}
				return json.Marshal(current)
			}}
			h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				if input["action"] != "takeover-progress" {
					t.Fatal("unexpected management action")
				}
				progress := input["payload"].(engineeringRepairProgress)
				if progress.WorkspaceVersion == nil {
					t.Fatal("missing actual source version")
				}
				writes++
				return json.RawMessage(`{}`), nil
			}}
			raw, _ := json.Marshal(initial)
			err := h.recordEngineeringRepairWorkspaceVersion(context.Background(), json.RawMessage(`{}`), testWorkspaceID, "original-issue", "original-case", "original-observation", initial.SnapshotHash, raw)
			if change == "none" {
				if err != nil || writes != 1 || checks != 1 {
					t.Fatal("matching version was not persisted after native revalidation", err)
				}
			} else if err == nil || writes != 0 {
				t.Fatal("changed ownership or source persisted a version", err)
			}
		})
	}
}
