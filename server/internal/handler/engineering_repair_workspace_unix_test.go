//go:build darwin || linux

package handler

import (
	"context"
	"encoding/json"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/engineering/processidentity"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

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
	renew := func() {
		t.Helper()
		var result struct {
			Renewed bool `json:"renewed"`
		}
		if err := json.Unmarshal(call(management, map[string]any{"action": "renew", "authority": acquired.Authority}), &result); err != nil || !result.Renewed {
			t.Fatal("fixture supervision lease did not renew", err)
		}
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
	investigator := exec.Command("/bin/sleep", "120")
	investigator.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err = investigator.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = investigator.Wait(); close(exited) }()
	defer func() { _ = investigator.Process.Kill(); <-exited }()
	investigatorMarker, err := processidentity.Marker(investigator.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	call(management, map[string]any{"action": "bind", "claim": allocated.Claim, "payload": map[string]any{"pid": investigator.Process.Pid, "marker": investigatorMarker, "group_id": investigator.Process.Pid}})
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
	if _, err = f.h.PrepareEngineeringRepairWorkspace(ctx, allocated.Claim, json.RawMessage(`{"action":"workspace-write","reason":"Repair original source"}`)); err == nil {
		t.Fatal("draining source granted writes")
	}
	targetsHash := state.Progress.TargetsHash
	renew()
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
	renew()
	grant, err := f.h.PrepareEngineeringRepairWorkspace(ctx, allocated.Claim, json.RawMessage(`{"action":"workspace-write","reason":"Repair original source"}`))
	if err != nil || !strings.Contains(string(grant), "baselineVersion") {
		t.Fatal("native owned source did not grant scoped writes", err)
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
	renew()
	candidate, err := f.h.PrepareEngineeringRepairWorkspace(ctx, allocated.Claim, json.RawMessage(`{"action":"workspace-candidate","key":"actual"}`))
	if err != nil || !strings.Contains(string(candidate), *state.Progress.WorkspaceVersion) {
		t.Fatal("host did not capture actual repaired content", err)
	}
	call(management, map[string]any{"action": "command", "claim": allocated.Claim, "payload": map[string]any{"action": "evidence", "key": "candidate-change", "kind": "change", "payload": map[string]string{"fact": "Fixture candidate content inspected"}}})
	submission := map[string]any{"outcome": "verification-requested", "summary": "Request independent original checks", "repairVersion": *state.Progress.WorkspaceVersion, "originalObservationIds": status.Originals, "repairEvidenceKeys": []string{"candidate-change", "native-candidate/actual"}, "verification": map[string]any{"reproductionCommand": "REPAIRER_COMMAND_MUST_NOT_RUN", "versionCheckCommand": "REPAIRER_VERSION_MUST_NOT_RUN", "acceptanceChecks": []any{map[string]string{"targetRef": "replacement", "command": "REPAIRER_ACCEPTANCE_MUST_NOT_RUN", "expected": "Do not inherit this"}}}}
	call(management, map[string]any{"action": "command", "claim": allocated.Claim, "payload": map[string]any{"action": "submit", "result": submission}})
	if err = os.WriteFile(filepath.Join(repository, "uncommitted-repair.txt"), []byte("Changed after submitted version"), 0600); err != nil {
		t.Fatal(err)
	}
	renew()
	if err = f.h.PrepareEngineeringRepairVerification(ctx, allocated.Claim); err == nil || !strings.Contains(err.Error(), "actual repair version") {
		t.Fatal("host did not reject the actual changed submitted version", err)
	}
	if err = os.WriteFile(filepath.Join(repository, "uncommitted-repair.txt"), []byte("Actual candidate source"), 0600); err != nil {
		t.Fatal(err)
	}
	renew()
	if err = f.h.PrepareEngineeringRepairVerification(ctx, allocated.Claim); err != nil {
		t.Fatal(err)
	}
	var prepared struct {
		VerificationInput struct {
			Hash  string `json:"hash"`
			Input struct {
				ExpectedVersion string            `json:"expectedVersion"`
				Targets         []json.RawMessage `json:"targets"`
				Originals       []json.RawMessage `json:"originalObservations"`
			} `json:"input"`
		} `json:"verificationInput"`
	}
	var repairIdentity struct {
		AttemptID string `json:"attemptId"`
	}
	if err = json.Unmarshal(allocated.Claim, &repairIdentity); err != nil {
		t.Fatal(err)
	}
	preparedRaw := call(management, map[string]any{"action": "verification-input", "authority": acquired.Authority, "attempt_id": repairIdentity.AttemptID})
	if err = json.Unmarshal(preparedRaw, &prepared.VerificationInput); err != nil || len(prepared.VerificationInput.Hash) != 64 || prepared.VerificationInput.Input.ExpectedVersion != *state.Progress.WorkspaceVersion || len(prepared.VerificationInput.Input.Targets) != 3 || len(prepared.VerificationInput.Input.Originals) != 1 {
		t.Fatal("host did not freeze the exact original Direct input and submitted candidate", err)
	}
	inputRaw, _ := json.Marshal(prepared.VerificationInput)
	if strings.Contains(string(inputRaw), "REPAIRER_") || !strings.Contains(string(inputRaw), "Original local work") {
		t.Fatal("repairer proposal replaced the independent original input")
	}
	call(management, map[string]any{"action": "finish", "claim": allocated.Claim, "payload": map[string]any{"exit_confirmed": false, "reason": "Fixture cleanup is not yet confirmed"}})
	var repairCase struct {
		Status string `json:"status"`
	}
	caseStatus := func() string {
		t.Helper()
		if err = json.Unmarshal(call(management, map[string]string{"action": "issue", "workspace_id": testWorkspaceID, "issue_id": f.issue}), &repairCase); err != nil {
			t.Fatal(err)
		}
		return repairCase.Status
	}
	if caseStatus() != "running" {
		t.Fatal("unconfirmed repair exit advanced independent verification")
	}
	if err = investigator.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-exited
	if !processidentity.GroupGone(investigator.Process.Pid) {
		t.Fatal("repair fixture still owns its group")
	}
	if _, err = f.h.PrepareEngineeringRepairWorkspace(ctx, allocated.Claim, json.RawMessage(`{"action":"workspace-candidate","key":"after-exit"}`)); err == nil || !strings.Contains(err.Error(), "actual bound investigator group") {
		t.Fatal("exited investigator retained native write/capture capability", err)
	}

	call(management, map[string]any{"action": "finish", "claim": allocated.Claim, "payload": map[string]any{"exit_confirmed": true, "reason": "Recorded fixture investigator physically exited"}})
	if caseStatus() != "verifying" {
		t.Fatal("prepared request did not wait for independent verification")
	}
	permission := call(business, map[string]any{"action": "execution-permission", "actor": map[string]string{"kind": "host", "workspaceId": testWorkspaceID, "issueId": f.issue}})
	if string(permission) != `{"allowed":false}` {
		t.Fatal("verification request resumed original business", string(permission))
	}
	renew()
	var independent struct {
		Claim   json.RawMessage `json:"claim"`
		Attempt struct {
			Role       string `json:"role"`
			Status     string `json:"status"`
			Generation int64  `json:"generation"`
			ID         string `json:"attemptId"`
		} `json:"attempt"`
	}
	if err = json.Unmarshal(call(management, map[string]any{"action": "claim", "authority": acquired.Authority}), &independent); err != nil || independent.Attempt.Role != "verification" || independent.Attempt.Status != "waiting" {
		t.Fatal("independent Test did not allocate a waiting generation", err)
	}
	if err = f.h.ReconcileEngineeringTakeovers(ctx, acquired.Authority); err != nil {
		t.Fatal(err)
	}
	renew()
	if err = f.h.ValidateEngineeringIndependentVerification(ctx, independent.Claim); err != nil {
		t.Fatal(err)
	}
	fence, err = f.h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)})
	if err != nil || fence.Generation != independent.Attempt.Generation || fence.AttemptID != independent.Attempt.ID || fence.Phase != "owned" {
		t.Fatal("independent generation did not reauthorize the exact original native fence", err)
	}
	if err = os.WriteFile(filepath.Join(repository, "uncommitted-repair.txt"), []byte("Wrong version before independent launch"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = f.h.ValidateEngineeringIndependentVerification(ctx, independent.Claim); err == nil {
		t.Fatal("independent launch accepted stale frozen source content")
	}
	if err = os.WriteFile(filepath.Join(repository, "uncommitted-repair.txt"), []byte("Actual candidate source"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = f.h.ValidateEngineeringIndependentVerification(ctx, independent.Claim); err != nil {
		t.Fatal(err)
	}
	call(management, map[string]any{"action": "verification-wait-cancel", "authority": acquired.Authority, "attempt_id": independent.Attempt.ID})
	cancel()
}
