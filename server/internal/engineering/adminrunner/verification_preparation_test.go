//go:build darwin || linux

package adminrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/engineering"
)

// A test-created provider authors real assertions without management credentials.
func fixtureIndependentPlan() {
	if os.Getenv("MULTICA_ADMIN_SOCKET") != "" || os.Getenv("MULTICA_ADMIN_TOKEN") != "" || os.Getenv("DATABASE_URL") != "" {
		os.Exit(86)
	}
	raw, err := os.ReadFile(os.Getenv("MULTICA_VERIFICATION_INPUT"))
	if err != nil {
		os.Exit(87)
	}
	var facts struct {
		Input struct {
			Targets []struct {
				TargetRef string `json:"targetRef"`
			} `json:"targets"`
			Binding struct {
				Root string `json:"workspaceRoot"`
			} `json:"workspaceBinding"`
		} `json:"input"`
	}
	if json.Unmarshal(raw, &facts) != nil || len(facts.Input.Targets) == 0 {
		os.Exit(88)
	}
	directory := filepath.Dir(os.Getenv("MULTICA_VERIFICATION_INPUT"))
	script := filepath.Join(directory, "assert-original.cjs")
	code := `const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');assert.equal(fs.readFileSync(path.join(process.argv[2],'source.txt'),'utf8'),'fixed');`
	switch os.Getenv("MULTICA_FIXTURE_VERIFICATION_MODE") {
	case "check-fail":
		code = `require('node:assert/strict').equal('actual','wrong-original-expectation');`
	case "source-write":
		code = `require('node:fs').writeFileSync(require('node:path').join(process.argv[2],'source.txt'),'unexpected check edit');`
	case "artifact-write":
		code = `require('node:fs').appendFileSync(__filename,'\n// changed frozen script');`
	case "leftover":
		code = `require('node:child_process').spawn('/bin/sleep',['10'],{stdio:'ignore'}).unref();`
	case "overflow":
		code = `process.stdout.write(Buffer.alloc(3*1024*1024,'x'));`
	case "timeout":
		code = `setTimeout(()=>{},10000);`
	case "user-stop":
		code = `require('node:fs').writeFileSync(require('node:path').join(process.env.HOME,'native-check-ready'),'ready');setTimeout(()=>{},10000);`
	}
	if err = os.WriteFile(script, []byte(code), 0600); err != nil {
		os.Exit(89)
	}
	command := fmt.Sprintf("node %q %q", script, facts.Input.Binding.Root)
	checks := []map[string]string{}
	for _, target := range facts.Input.Targets {
		checks = append(checks, map[string]string{"targetRef": target.TargetRef, "command": command})
	}
	mode := os.Getenv("MULTICA_FIXTURE_VERIFICATION_MODE")
	if mode == "omit" {
		checks = checks[:len(checks)-1]
	}
	if mode == "tamper" {
		if err = os.WriteFile(filepath.Join(facts.Input.Binding.Root, "source.txt"), []byte("changed by independent author"), 0600); err != nil {
			os.Exit(90)
		}
	}
	plan, _ := json.Marshal(map[string]any{"reproduction": map[string]string{"targetRef": "original-failures", "command": command}, "acceptanceChecks": checks})
	if err = os.WriteFile(os.Getenv("MULTICA_VERIFICATION_RESULT"), plan, 0600); err != nil {
		os.Exit(91)
	}
}
func TestIndependentTestPreparationUsesSeparateFixtureAndPreservesActualArtifacts(t *testing.T) {
	for _, mode := range []string{"success", "omit", "tamper", "check-fail", "source-write", "artifact-write", "artifact-mutated", "plan-metadata-corrupt", "timeout", "overflow", "leftover", "user-stop"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			for _, key := range []string{"HOME", "USERPROFILE", "CODEX_HOME"} {
				t.Setenv(key, root)
			}
			t.Setenv("DATABASE_URL", "must-not-inherit")
			t.Setenv("MULTICA_ADMIN_TOKEN", "must-not-inherit")
			repository := filepath.Join(root, "repository")
			if err := os.Mkdir(repository, 0700); err != nil {
				t.Fatal(err)
			}
			for _, args := range [][]string{{"init", "-q"}, {"-c", "user.name=Verification fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Original source"}} {
				cmd := exec.Command("git", args...)
				cmd.Dir = repository
				if out, err := cmd.CombinedOutput(); err != nil {
					t.Fatal(err, string(out))
				}
			}
			if err := os.WriteFile(filepath.Join(repository, "source.txt"), []byte("fixed"), 0600); err != nil {
				t.Fatal(err)
			}
			versionModule, err := filepath.Abs("../../../../packages/command-chain/repair-workspace-version.ts")
			if err != nil {
				t.Fatal(err)
			}
			readVersion := func() string {
				t.Helper()
				cmd := exec.Command("node", "--input-type=module", "-e", `const esbuild=await import('esbuild');const result=await esbuild.build({entryPoints:[process.argv[1]],bundle:true,platform:'node',format:'esm',target:'node22',write:false});const module=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));console.log(await module.readRepairWorkspaceVersion(process.argv[2]));esbuild.stop();`, versionModule, repository)
				cmd.Dir = filepath.Dir(versionModule)
				out, err := cmd.CombinedOutput()
				if err != nil {
					t.Fatal(err, string(out))
				}
				return strings.TrimSpace(string(out))
			}
			expected := readVersion()
			binary, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			provider := filepath.Join(root, "codex-fixture")
			wrapper := "#!/bin/sh\nexport MULTICA_FIXTURE_ADMIN_PROVIDER=1\nexport MULTICA_FIXTURE_VERIFICATION_MODE=" + mode + "\nexec '" + strings.ReplaceAll(binary, "'", "'\\''") + "' -test.run '^TestAdminFakeProviderHelper$'\n"
			if err = os.WriteFile(provider, []byte(wrapper), 0700); err != nil {
				t.Fatal(err)
			}
			worker, err := filepath.Abs("../../../../packages/command-chain/dist/worker.mjs")
			if err != nil {
				t.Fatal(err)
			}
			client := &engineering.Client{Worker: worker, Database: filepath.Join(root, "admin.sqlite"), Admin: true}
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
			defer cancel()
			call := func(input any) json.RawMessage {
				t.Helper()
				raw, err := client.Call(ctx, input)
				if err != nil {
					t.Fatal(err)
				}
				return raw
			}
			var acquired struct {
				Authority authority `json:"authority"`
			}
			if err = json.Unmarshal(call(map[string]any{"action": "acquire", "owner_id": "fixture-host", "execution_supported": true}), &acquired); err != nil {
				t.Fatal(err)
			}
			workspace, issue := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
			original := map[string]any{"observationId": "original-failure", "workspaceId": workspace, "issueId": issue, "attemptId": "native:123", "chain": "direct", "snapshotHash": "original-snapshot", "receiptHash": "original-receipt", "snapshot": map[string]any{"direct": map[string]string{"input": "source.txt must contain the original expected value"}}}
			call(map[string]any{"action": "observe", "authority": acquired.Authority, "observation": map[string]any{"observationId": "original-failure", "workspaceId": workspace, "issueId": issue, "scope": "work-item", "scopeKey": "original-issue", "fingerprint": "original-failure", "sourceVersion": "original-runtime", "summary": "Original conflict", "origin": "business", "evidence": map[string]any{"original": original}}})
			call(map[string]any{"action": "configuration", "payload": map[string]any{"expected_revision": 0, "configuration": map[string]string{"provider": "codex", "executablePath": provider}}})
			call(map[string]any{"action": "intent", "payload": map[string]string{"intent": "running", "request_id": "start"}})
			var repair struct {
				Claim claim `json:"claim"`
			}
			if err = json.Unmarshal(call(map[string]any{"action": "claim", "authority": acquired.Authority}), &repair); err != nil {
				t.Fatal(err)
			}
			command := func(payload any) json.RawMessage {
				return call(map[string]any{"action": "command", "claim": repair.Claim, "payload": payload})
			}
			command(map[string]string{"action": "status"})
			command(map[string]string{"action": "workspace-takeover", "observation_id": "original-failure", "reason": "Preserve the original input"})
			call(map[string]any{"action": "takeover-inspected", "claim": repair.Claim, "payload": map[string]any{"observation_id": "original-failure", "snapshot_hash": "original-snapshot", "source_attempt_id": "native:123", "project_id": "33333333-3333-4333-8333-333333333333", "runtime_id": "44444444-4444-4444-8444-444444444444", "registered_repository_path": repository, "execution_repository_path": repository, "mode": "in_place", "receipt_hash": "original-receipt", "code_version": "original-code", "kernel_version": "original-kernel", "host_version": "original-host"}})
			progress := map[string]any{"phase": "owned", "cancelled": 1, "unfinished_controllers": 0, "unknown_tasks": 0, "targets_hash": strings.Repeat("a", 64), "workspace_root": repository, "workspace_version": expected, "source_attempt_id": "native:123", "snapshot_hash": "original-snapshot"}
			call(map[string]any{"action": "takeover-progress", "claim": repair.Claim, "payload": progress})
			command(map[string]any{"action": "evidence", "key": "change", "kind": "change", "payload": map[string]string{"fact": "Authorized fixture candidate inspected"}})
			command(map[string]any{"action": "submit", "result": map[string]any{"outcome": "verification-requested", "summary": "Request an independent original-contract check", "repairVersion": expected, "originalObservationIds": []string{"original-failure"}, "repairEvidenceKeys": []string{"change"}, "verification": map[string]any{"reproductionCommand": "REPAIRER_PROPOSAL", "versionCheckCommand": "REPAIRER_PROPOSAL", "acceptanceChecks": []any{map[string]string{"targetRef": "replacement", "command": "REPAIRER_PROPOSAL", "expected": "Do not adopt"}}}}})
			call(map[string]any{"action": "verification-prepare", "claim": repair.Claim})
			call(map[string]any{"action": "finish", "claim": repair.Claim, "payload": map[string]any{"exit_confirmed": true, "reason": "Original fixture invocation never spawned"}})
			scopeCalls := 0
			nativeWorker := filepath.Join(root, "native-check-worker")
			workerWrapper := "#!/bin/sh\nexport MULTICA_FIXTURE_VERIFICATION_WORKER=1\nexec '" + strings.ReplaceAll(binary, "'", "'\\''") + "' -test.run '^TestNativeVerificationWorkerFixture$'\n"
			if err = os.WriteFile(nativeWorker, []byte(workerWrapper), 0700); err != nil {
				t.Fatal(err)
			}
			runner := &Runner{Client: client, Root: filepath.Join(root, "runtime"), Multica: nativeWorker, CheckTimeout: 800 * time.Millisecond}
			if mode == "user-stop" {
				runner.CheckTimeout = 10 * time.Second
			}
			runner.VerifyScope = func(ctx context.Context, identity json.RawMessage) error {
				scopeCalls++
				if _, err := client.Call(ctx, map[string]any{"action": "renew", "authority": acquired.Authority}); err != nil {
					return err
				}
				var current claim
				if err := json.Unmarshal(identity, &current); err != nil {
					return err
				}
				if readVersion() != expected {
					return fmt.Errorf("actual candidate version changed")
				}
				_, err := client.Call(ctx, map[string]any{"action": "takeover-progress", "claim": current, "payload": progress})
				return err
			}
			if err = runner.Tick(ctx, acquired.Authority.OwnerID, acquired.Authority.Token); err != nil {
				t.Fatal(err)
			}
			var state struct {
				Active []attempt `json:"active"`
			}
			if err = json.Unmarshal(call(map[string]string{"action": "state"}), &state); err != nil || len(state.Active) != 1 || state.Active[0].Status != "waiting" || state.Active[0].PID != nil {
				t.Fatal("new Test did not wait for separate ownership", err)
			}
			old := state.Active[0]
			identity := claim{Authority: acquired.Authority, CaseID: old.CaseID, AttemptID: old.AttemptID, Generation: old.Generation, SessionID: old.SessionID}
			call(map[string]any{"action": "takeover-progress", "claim": identity, "payload": progress})
			if err = runner.Tick(ctx, acquired.Authority.OwnerID, acquired.Authority.Token); err != nil {
				t.Fatal(err)
			}
			runner.mu.Lock()
			run := runner.active
			runner.mu.Unlock()
			if run == nil {
				t.Fatal("separate Test did not launch")
			}
			select {
			case <-run.done:
			case <-ctx.Done():
				t.Fatal("independent Test never physically settled")
			}
			if !runner.Stop(ctx) {
				t.Fatal("independent Test group exit unconfirmed")
			}
			var repairCase struct {
				Status string `json:"status"`
				Count  int    `json:"observation_count"`
			}
			if err = json.Unmarshal(call(map[string]string{"action": "issue", "workspace_id": workspace, "issue_id": issue}), &repairCase); err != nil {
				t.Fatal(err)
			}
			plan := call(map[string]any{"action": "verification-plan-read", "authority": acquired.Authority, "attempt_id": identity.AttemptID})
			if mode != "omit" && mode != "tamper" {
				if repairCase.Status != "verification-prepared" || string(plan) == "null" || scopeCalls < 3 {
					t.Fatal("separate plan preparation failed", repairCase.Status, string(plan))
				}
				if strings.Contains(string(plan), "REPAIRER_PROPOSAL") {
					t.Fatal("repairer proposal entered independent plan")
				}
				var saved struct {
					Artifacts verificationArtifacts `json:"artifacts"`
				}
				if err = json.Unmarshal(plan, &saved); err != nil {
					t.Fatal(err)
				}
				manifest, err := readVerificationArtifacts(ctx, saved.Artifacts.Directory)
				if err != nil {
					t.Fatal(err)
				}
				if len(manifest.Files) < 3 {
					t.Fatal("actual plan scripts and original facts were not retained")
				}
			}
			if (mode == "omit" || mode == "tamper") && (repairCase.Status != "queued" || string(plan) != "null") {
				t.Fatal("invalid or source-writing Test entered prepared state", repairCase.Status, string(plan))
			}
			if repairCase.Count != 1 {
				t.Fatal("original failure history changed")
			}
			if mode == "omit" || mode == "tamper" {
				return
			}
			if mode == "artifact-mutated" {
				var saved struct {
					Artifacts verificationArtifacts `json:"artifacts"`
				}
				if err = json.Unmarshal(plan, &saved); err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(filepath.Join(saved.Artifacts.Directory, "assert-original.cjs"), []byte("throw Error('replaced witness');"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "plan-metadata-corrupt" {
				mutate := exec.Command("node", "-e", `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);const row=db.prepare('SELECT payload FROM admin_verification_plan WHERE attempt_id=?').get(process.argv[2]);const plan=JSON.parse(row.payload);plan.acceptanceChecks[0].command='printf fake-pass';db.prepare('UPDATE admin_verification_plan SET payload=? WHERE attempt_id=?').run(JSON.stringify(plan),process.argv[2]);db.close();`, client.Database, identity.AttemptID)
				if out, err := mutate.CombinedOutput(); err != nil {
					t.Fatal(err, string(out))
				}
			}
			// A new generation and private worker execute the retained plan.
			if err = runner.Tick(ctx, acquired.Authority.OwnerID, acquired.Authority.Token); err != nil {
				t.Fatal(err)
			}
			if err = runner.Tick(ctx, acquired.Authority.OwnerID, acquired.Authority.Token); err != nil {
				t.Fatal(err)
			}
			if err = json.Unmarshal(call(map[string]string{"action": "state"}), &state); err != nil || len(state.Active) != 1 || state.Active[0].Role != "verification-execution" || state.Active[0].Status != "waiting" {
				t.Fatal("native execution did not wait for fresh ownership", err)
			}
			execution := state.Active[0]
			executionClaim := claim{Authority: acquired.Authority, CaseID: execution.CaseID, AttemptID: execution.AttemptID, Generation: execution.Generation, SessionID: execution.SessionID}
			call(map[string]any{"action": "takeover-progress", "claim": executionClaim, "payload": progress})
			if err = runner.Tick(ctx, acquired.Authority.OwnerID, acquired.Authority.Token); err != nil {
				t.Fatal(err)
			}
			runner.mu.Lock()
			native := runner.active
			runner.mu.Unlock()
			if native == nil {
				t.Fatal("native execution did not launch")
			}
			if mode == "user-stop" {
				for {
					if _, err = os.Stat(filepath.Join(root, "native-check-ready")); err == nil {
						break
					}
					select {
					case <-ctx.Done():
						t.Fatal("native check never reached its actual command")
					case <-time.After(10 * time.Millisecond):
					}
				}
				call(map[string]any{"action": "intent", "payload": map[string]string{"intent": "stopped", "request_id": "stop-native"}})
				if err = runner.Tick(ctx, acquired.Authority.OwnerID, acquired.Authority.Token); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-native.done:
			case <-ctx.Done():
				t.Fatal("native checks did not settle")
			}
			if !runner.Stop(ctx) {
				t.Fatal("native check worker or descendants still own physical execution")
			}
			if err = json.Unmarshal(call(map[string]string{"action": "issue", "workspace_id": workspace, "issue_id": issue}), &repairCase); err != nil {
				t.Fatal(err)
			}
			receipt := call(map[string]any{"action": "verification-receipt", "authority": acquired.Authority, "attempt_id": execution.AttemptID})
			var verdict struct {
				Passed       bool `json:"passed"`
				WorkerExited bool `json:"workerExitConfirmed"`
				Checks       []struct {
					Kind   string              `json:"kind"`
					Result *nativeCheckReceipt `json:"result"`
				} `json:"checks"`
			}
			if string(receipt) != "null" && json.Unmarshal(receipt, &verdict) != nil {
				t.Fatal("invalid native receipt")
			}
			if mode == "success" {
				if repairCase.Status != "verified" || !verdict.Passed || !verdict.WorkerExited || len(verdict.Checks) != 6 {
					t.Fatal("actual native original checks did not pass", repairCase.Status, string(receipt))
				}
				for _, check := range verdict.Checks {
					if check.Result == nil || !check.Result.ExitConfirmed || check.Result.WorkerPID == 0 {
						t.Fatal("check lacks physical identity")
					}
				}
			} else {
				if repairCase.Status != "queued" || verdict.Passed {
					t.Fatal("failed, stopped or changed verification passed", repairCase.Status, string(receipt))
				}
				if mode == "plan-metadata-corrupt" && len(verdict.Checks) != 0 {
					t.Fatal("metadata replacement ran commands absent from the frozen witness")
				}
				if mode == "check-fail" && (len(verdict.Checks) != 2 || verdict.Checks[1].Result == nil || verdict.Checks[1].Result.ExitCode == nil || *verdict.Checks[1].Result.ExitCode == 0) {
					t.Fatal("real assertion failure was lost", string(receipt))
				}
				if mode == "source-write" && (len(verdict.Checks) != 2 || verdict.Checks[1].Result == nil || verdict.Checks[1].Result.ScopeConfirmed) {
					t.Fatal("source mutation was not retained as failed evidence", string(receipt))
				}
				if mode == "overflow" && (len(verdict.Checks) != 2 || verdict.Checks[1].Result == nil || !verdict.Checks[1].Result.Truncated) {
					t.Fatal("actual evidence overflow was not retained as a failure")
				}
				if mode == "leftover" && (len(verdict.Checks) != 2 || verdict.Checks[1].Result == nil || verdict.Checks[1].Result.ExitConfirmed) {
					t.Fatal("a surviving descendant was treated as exited", string(receipt))
				}
				if mode == "artifact-write" && (len(verdict.Checks) != 2 || verdict.Checks[1].Result == nil || verdict.Checks[1].Result.ArtifactsUnchanged) {
					t.Fatal("artifact mutation was not captured", string(receipt))
				}
			}
			if repairCase.Count != 1 {
				t.Fatal("native checks altered original observations")
			}
		})
	}
}
