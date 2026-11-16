package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/engineering/processidentity"
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
	for key, wrong := range map[string]any{"revision": 0, "receipt_hash": "replacement", "host_version": "new-api", "kernel_version": "new-kernel", "code_version": "different-code", "execution_repository_path": "/invented"} {
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

func TestEngineeringTakeoverBundledWorkersAndPrivateControl(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	worker, err := filepath.Abs("../../../packages/command-chain/dist/worker.mjs")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(worker); err != nil {
		t.Fatal("build the command-chain worker before integration", err)
	}
	root, err := os.MkdirTemp("", "tk-rpc-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	repository := filepath.Join(root, "repository")
	if err = os.Mkdir(repository, 0700); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-q"}, {"-c", "user.name=Repair fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Original source"}} {
		command := exec.Command("git", args...)
		command.Dir = repository
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("prepare temporary source: %v: %s", err, output)
		}
	}
	repository, err = filepath.EvalSymlinks(repository)
	if err != nil {
		t.Fatal(err)
	}
	f := newControllerFixture(t)
	host, err := processidentity.HostID()
	if err != nil {
		t.Skip("local physical identity unavailable")
	}
	marker, err := processidentity.Marker(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	f.call(t, "begin", map[string]any{"provider": "codex", "host_id": host, "pid": os.Getpid(), "marker": marker}, 200)
	f.call(t, "workspace", map[string]any{"host_id": host, "workspace_path": repository, "mode": "in_place"}, 200)
	native := mustControllerTask(t, f)
	dbfx.Exec(t, "UPDATE agent_runtime SET runtime_mode='local',daemon_id='takeover-rpc-fixture' WHERE id=$1", uuidToString(native.RuntimeID))
	resource, _ := json.Marshal(map[string]any{"local_path": repository, "daemon_id": "takeover-rpc-fixture", "execution_mode": "in_place"})
	dbfx.Insert(t, "project_resource", testutil.Cols{"project_id": f.project, "workspace_id": testWorkspaceID, "resource_type": "local_directory", "resource_ref": json.RawMessage(resource)})
	database := filepath.Join(root, "b.sqlite")
	business := &engineering.Client{Worker: worker, Database: database}
	management := &engineering.Client{Worker: worker, Database: database + ".admin.sqlite", Admin: true}
	call := func(client *engineering.Client, input any) json.RawMessage {
		t.Helper()
		result, err := client.Call(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	actor := map[string]string{"kind": "task", "workspaceId": testWorkspaceID, "issueId": f.issue, "projectId": f.project, "agentId": uuidToString(native.AgentID), "attemptId": f.task + ":" + strconv.FormatInt(native.DispatchedAt.Time.UnixMicro(), 10)}
	human := map[string]string{"kind": "human", "workspaceId": testWorkspaceID, "issueId": f.issue, "userId": testUserID}
	call(business, map[string]any{"action": "configure-direct", "actor": human, "payload": map[string]any{"expected_revision": 0, "agent_id": uuidToString(native.AgentID), "project_id": f.project, "repository_path": repository, "input": "Original local work", "execution_resources": []any{map[string]string{"path": repository, "mode": "in_place"}}}})
	daemon := map[string]string{}
	for key, value := range actor {
		daemon[key] = value
	}
	daemon["kind"] = "daemon"
	call(business, map[string]any{"action": "bind", "actor": daemon, "payload": map[string]any{"work_dir": repository, "mode": "in_place", "overlays": []any{}}})
	call(business, map[string]any{"action": "direct-run", "actor": actor})
	call(business, map[string]any{"action": "intervention-request", "actor": actor, "host_version": "sha256:" + strings.Repeat("a", 64), "payload": map[string]string{"summary": "Original conflict", "reason": "Requires independent recovery", "evidence": "Original evidence retained"}})
	var acquired struct {
		Authority engineeringAdminAuthority `json:"authority"`
	}
	if err = json.Unmarshal(call(management, map[string]any{"action": "acquire", "owner_id": "rpc-fixture", "execution_supported": true}), &acquired); err != nil {
		t.Fatal(err)
	}
	f.h.EngineeringWorker = business
	f.h.EngineeringAdminWorker = management
	if err = f.h.ReconcileEngineeringAdmin(ctx, acquired.Authority); err != nil {
		t.Fatal(err)
	}
	call(management, map[string]any{"action": "configuration", "payload": map[string]any{"expected_revision": 0, "configuration": map[string]string{"provider": "codex", "executablePath": "/fixture/never-launched"}}})
	call(management, map[string]any{"action": "intent", "payload": map[string]string{"intent": "running", "request_id": "fixture-start"}})
	var allocated struct {
		Claim json.RawMessage `json:"claim"`
	}
	if err = json.Unmarshal(call(management, map[string]any{"action": "claim", "authority": acquired.Authority}), &allocated); err != nil {
		t.Fatal(err)
	}
	var status struct {
		Originals []string `json:"requiredOriginalObservationIds"`
	}
	if err = json.Unmarshal(call(management, map[string]any{"action": "command", "claim": allocated.Claim, "payload": map[string]string{"action": "status"}}), &status); err != nil || len(status.Originals) != 1 {
		t.Fatal("missing original observation", err)
	}
	call(management, map[string]any{"action": "command", "claim": allocated.Claim, "payload": map[string]string{"action": "workspace-takeover", "observation_id": status.Originals[0], "reason": "Recover the original workspace"}})
	f.h.cfg.EngineeringDatabasePath = database
	if err = f.h.StartEngineeringLocalControl(ctx); err != nil {
		t.Fatal(err)
	}
	f.h.EngineeringTakeoverControl = &engineering.LocalControlClient{Socket: database + ".control.sock"}
	if err = f.h.ReconcileEngineeringTakeovers(ctx, acquired.Authority); err != nil {
		t.Fatal(err)
	}
	fence, err := f.h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)})
	if err != nil || fence.Phase != "draining" || fence.SourceRevision != 1 || fence.ObservationID != status.Originals[0] {
		t.Fatal("private transport did not acquire original fence", err)
	}
	if mustControllerTask(t, f).Status != "cancelled" {
		t.Fatal("private transport did not cancel native source")
	}
	controllers, err := f.h.Queries.ListEngineeringProjectControllers(ctx, db.ListEngineeringProjectControllersParams{WorkspaceID: fence.WorkspaceID, ProjectID: fence.ProjectID})
	if err != nil || len(controllers) != 1 || controllers[0].Phase != "executing" {
		t.Fatal("transport invented physical cleanup", err)
	}
	var state struct {
		Progress engineeringRepairProgress `json:"takeoverProgress"`
	}
	if err = json.Unmarshal(call(management, map[string]any{"action": "command", "claim": allocated.Claim, "payload": map[string]string{"action": "status"}}), &state); err != nil || state.Progress.Phase != "draining" || state.Progress.WorkspaceRoot != nil || len(state.Progress.TargetsHash) != 64 {
		t.Fatal("private drain progress was not durable in management storage", err)
	}
	targetsHash := state.Progress.TargetsHash
	f.call(t, "end", map[string]any{"host_id": host, "no_provider_started": true}, 200)
	if err = f.h.ReconcileEngineeringTakeovers(ctx, acquired.Authority); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(call(management, map[string]any{"action": "command", "claim": allocated.Claim, "payload": map[string]string{"action": "status"}}), &state); err != nil || state.Progress.Phase != "owned" || state.Progress.WorkspaceRoot == nil || *state.Progress.WorkspaceRoot != repository || state.Progress.TargetsHash != targetsHash {
		t.Fatal("final controller receipt did not produce the same owned cohort through private transport", err)
	}
	if state.Progress.WorkspaceVersion == nil || !strings.HasPrefix(*state.Progress.WorkspaceVersion, "workspace-content-v1:") {
		t.Fatal("owned transport did not record the actual source version")
	}
	originalVersion := *state.Progress.WorkspaceVersion
	if err = os.WriteFile(filepath.Join(repository, "uncommitted-repair.txt"), []byte("Actual candidate source"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = f.h.ReconcileEngineeringTakeovers(ctx, acquired.Authority); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(call(management, map[string]any{"action": "command", "claim": allocated.Claim, "payload": map[string]string{"action": "status"}}), &state); err != nil || state.Progress.WorkspaceVersion == nil || *state.Progress.WorkspaceVersion == originalVersion || state.Progress.TargetsHash != targetsHash {
		t.Fatal("current content version did not follow actual source changes within the same owned cohort", err)
	}
	cancel()
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
