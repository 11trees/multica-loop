//go:build darwin || linux

package adminrunner

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/engineering/processidentity"
)

// This executable is a test-created provider, with no vendor executable lookup.
func TestAdminFakeProviderHelper(t *testing.T) {
	if os.Getenv("MULTICA_FIXTURE_ADMIN_PROVIDER") != "1" {
		return
	}
	if os.Getenv("DATABASE_URL") != "" || os.Getenv("MULTICA_ENGINEERING_DATABASE") != "" {
		os.Exit(80)
	}
	output := json.NewEncoder(os.Stdout)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 4<<20)
	for scanner.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(81)
		}
		if len(request.ID) == 0 {
			continue
		}
		result := any(map[string]any{})
		switch request.Method {
		case "thread/start":
			result = map[string]any{"thread": map[string]any{"id": "fixture-thread"}}
		case "turn/interrupt":
			_ = output.Encode(map[string]any{"id": json.RawMessage(request.ID), "result": result})
			_ = output.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "fixture-thread", "turn": map[string]any{"id": "fixture-turn", "status": "interrupted"}}})
			continue
		case "turn/start":
			if os.Getenv("MULTICA_VERIFICATION_INPUT") != "" {
				fixtureIndependentPlan()
				_ = output.Encode(map[string]any{"id": json.RawMessage(request.ID), "result": map[string]any{"turn": map[string]any{"id": "fixture-turn", "status": "inProgress"}}})
				_ = output.Encode(map[string]any{"method": "turn/started", "params": map[string]any{"threadId": "fixture-thread", "turn": map[string]any{"id": "fixture-turn"}}})
				_ = output.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "fixture-thread", "turn": map[string]any{"id": "fixture-turn", "status": "completed"}}})
				continue
			}
			// The provider cannot issue its first command before the host persisted PID.
			status := fixtureAdminCommand(map[string]any{"action": "status"})
			var view struct {
				Attempt struct {
					PID    int    `json:"pid"`
					Marker string `json:"startMarker"`
				} `json:"attempt"`
			}
			if json.Unmarshal(status, &view) != nil || view.Attempt.PID != os.Getpid() || view.Attempt.Marker == "" {
				os.Exit(82)
			}
			if os.Getenv("MULTICA_FIXTURE_VERIFICATION_MODE") == "repair-write" {
				grantRaw := fixtureAdminCommand(map[string]any{"action": "workspace-write", "reason": "Repair original source"})
				var grant struct {
					Body struct {
						Root string `json:"workspaceRoot"`
					} `json:"body"`
				}
				if json.Unmarshal(grantRaw, &grant) != nil || grant.Body.Root == "" {
					os.Exit(86)
				}
				if err := os.WriteFile(filepath.Join(grant.Body.Root, "source.txt"), []byte("fixed"), 0600); err != nil {
					os.Exit(87)
				}
				candidateRaw := fixtureAdminCommand(map[string]any{"action": "workspace-candidate", "key": "actual"})
				var candidate struct {
					Body struct {
						Version     string `json:"version"`
						EvidenceKey string `json:"evidenceKey"`
					} `json:"body"`
				}
				if json.Unmarshal(candidateRaw, &candidate) != nil || candidate.Body.Version == "" {
					os.Exit(88)
				}
				fixtureAdminCommand(map[string]any{"action": "submit", "result": map[string]any{"outcome": "verification-requested", "summary": "Original source repaired by the bound fixture", "repairVersion": candidate.Body.Version, "originalObservationIds": []string{"original-failure"}, "repairEvidenceKeys": []string{candidate.Body.EvidenceKey}, "verification": map[string]any{"reproductionCommand": "REPAIRER_PROPOSAL", "versionCheckCommand": "REPAIRER_PROPOSAL", "acceptanceChecks": []any{map[string]string{"targetRef": "replacement", "command": "REPAIRER_PROPOSAL", "expected": "Do not inherit"}}}}})
				_ = output.Encode(map[string]any{"id": json.RawMessage(request.ID), "result": map[string]any{"turn": map[string]any{"id": "fixture-turn", "status": "inProgress"}}})
				_ = output.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "fixture-thread", "turn": map[string]any{"id": "fixture-turn", "status": "completed"}}})
				continue
			}
			if os.Getenv("MULTICA_FIXTURE_ADMIN_HOLD") == "1" {
				_ = output.Encode(map[string]any{"id": json.RawMessage(request.ID), "result": map[string]any{"turn": map[string]any{"id": "fixture-turn", "status": "inProgress"}}})
				_ = output.Encode(map[string]any{"method": "turn/started", "params": map[string]any{"threadId": "fixture-thread", "turn": map[string]any{"id": "fixture-turn"}}})
				if err := os.WriteFile(filepath.Join(os.Getenv("HOME"), "fixture-ready"), []byte("ready"), 0600); err != nil {
					os.Exit(85)
				}
				continue
			}
			fixtureAdminCommand(map[string]any{"action": "evidence", "key": "fixture-finding", "kind": "finding", "payload": map[string]any{"original_preserved": true}})
			fixtureAdminCommand(map[string]any{"action": "submit", "result": map[string]any{"outcome": "deferred", "summary": "Fixture investigation retained original evidence", "nextMethod": "Scoped takeover is required"}})
			result = map[string]any{"turn": map[string]any{"id": "fixture-turn", "status": "inProgress"}}
			_ = output.Encode(map[string]any{"id": json.RawMessage(request.ID), "result": result})
			_ = output.Encode(map[string]any{"method": "turn/started", "params": map[string]any{"threadId": "fixture-thread", "turn": map[string]any{"id": "fixture-turn"}}})
			_ = output.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "fixture-thread", "turn": map[string]any{"id": "fixture-turn", "status": "completed"}}})
			continue
		}
		_ = output.Encode(map[string]any{"id": json.RawMessage(request.ID), "result": result})
	}
	os.Exit(0)
}
func fixtureAdminCommand(input any) []byte {
	body, _ := json.Marshal(input)
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", os.Getenv("MULTICA_ADMIN_SOCKET"))
	}}
	defer transport.CloseIdleConnections()
	req, _ := http.NewRequest(http.MethodPost, "http://admin/command", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+os.Getenv("MULTICA_ADMIN_TOKEN"))
	response, err := (&http.Client{Transport: transport, Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		os.Exit(83)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 {
		fmt.Fprintln(os.Stderr, string(data))
		os.Exit(84)
	}
	return data
}

func TestAdminRunnerBindsRealFixtureProcessAndRetainsDeferredReceipt(t *testing.T) {
	for _, hold := range []bool{false, true} {
		t.Run(fmt.Sprintf("stop=%t", hold), func(t *testing.T) {

			worker, err := filepath.Abs("../../../../packages/command-chain/dist/worker.mjs")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = os.Stat(worker); err != nil {
				t.Skip("Build @multica/command-chain before running the bundled-worker integration")
			}
			root := t.TempDir()
			for _, key := range []string{"HOME", "USERPROFILE", "CODEX_HOME"} {
				t.Setenv(key, root)
			}
			// These inherited authorities must be absent in the fixture subprocess.
			t.Setenv("DATABASE_URL", "fixture-must-not-inherit")
			t.Setenv("MULTICA_ENGINEERING_DATABASE", "fixture-must-not-inherit")
			binary, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			provider := filepath.Join(root, "codex-fixture")
			holdEnvironment := ""
			if hold {
				holdEnvironment = "export MULTICA_FIXTURE_ADMIN_HOLD=1\n"
			}
			script := "#!/bin/sh\nexport MULTICA_FIXTURE_ADMIN_PROVIDER=1\n" + holdEnvironment + "exec '" + strings.ReplaceAll(binary, "'", "'\\''") + "' -test.run '^TestAdminFakeProviderHelper$'\n"
			if err = os.WriteFile(provider, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			client := &engineering.Client{Worker: worker, Database: filepath.Join(root, "admin.sqlite"), Admin: true}
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cancel()
			call := func(input any) json.RawMessage {
				t.Helper()
				result, err := client.Call(ctx, input)
				if err != nil {
					t.Fatal(err)
				}
				return result
			}
			var acquired struct {
				Authority authority `json:"authority"`
			}
			if err = json.Unmarshal(call(map[string]any{"action": "acquire", "owner_id": "fixture-host", "execution_supported": true}), &acquired); err != nil {
				t.Fatal(err)
			}
			call(map[string]any{"action": "observe", "authority": acquired.Authority, "observation": map[string]any{"observationId": "fixture-original", "workspaceId": "11111111-1111-4111-8111-111111111111", "issueId": "22222222-2222-4222-8222-222222222222", "scope": "work-item", "scopeKey": "fixture-issue", "fingerprint": "original-hash", "sourceVersion": "original-runtime", "summary": "Original oracle", "evidence": map[string]any{"failed": "original-check"}, "origin": "business"}})
			call(map[string]any{"action": "configuration", "payload": map[string]any{"expected_revision": 0, "configuration": map[string]any{"provider": "codex", "executablePath": provider}}})
			call(map[string]any{"action": "intent", "payload": map[string]any{"intent": "running", "request_id": "fixture-start"}})
			runner := &Runner{Client: client, Root: filepath.Join(root, "logs"), Multica: binary}
			if err = runner.Tick(ctx, acquired.Authority.OwnerID, acquired.Authority.Token); err != nil {
				t.Fatal(err)
			}
			runner.mu.Lock()
			run := runner.active
			runner.mu.Unlock()
			if run == nil {
				t.Fatal("No fixture investigation allocated")
			}
			if hold {
				for {
					if _, err = os.Stat(filepath.Join(root, "fixture-ready")); err == nil {
						break
					}
					select {
					case <-ctx.Done():
						t.Fatal("Fixture never entered its turn")
					case <-time.After(10 * time.Millisecond):
					}
				}
				call(map[string]any{"action": "intent", "payload": map[string]any{"intent": "stopped", "request_id": "fixture-user-stop"}})
				if err = runner.Tick(ctx, acquired.Authority.OwnerID, acquired.Authority.Token); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-run.done:
			case <-ctx.Done():
				t.Fatal("Fixture investigation did not settle")
			}
			if !runner.Stop(ctx) {
				t.Fatal("Fixture process exit was not confirmed")
			}
			var state struct {
				Active []attempt `json:"active"`
			}
			if err = json.Unmarshal(call(map[string]any{"action": "state"}), &state); err != nil || len(state.Active) != 0 {
				t.Fatalf("Physical allocation survived: %s", call(map[string]any{"action": "state"}))
			}
			if hold {
				run.mu.Lock()
				pid := run.pid
				run.mu.Unlock()
				if !processidentity.GroupGone(pid) {
					t.Fatal("Stopped invocation retains a live process group")
				}
				return
			}
			// Inspect the immutable receipt through a fresh invocation's bounded history.
			var next struct {
				Claim claim `json:"claim"`
			}
			if err = json.Unmarshal(call(map[string]any{"action": "claim", "authority": acquired.Authority}), &next); err != nil {
				t.Fatal(err)
			}
			status := string(call(map[string]any{"action": "command", "claim": next.Claim, "payload": map[string]any{"action": "status"}}))
			for _, expected := range []string{"fixture-finding", "Fixture investigation retained original evidence", "original-check", "deferred"} {
				if !strings.Contains(status, expected) {
					t.Fatalf("Lost %s in %s", expected, status)
				}
			}
			if !strings.Contains(status, `\"status\":\"failed\"`) {
				t.Fatalf("Deferred receipt did not remain a failed repair: %s", status)
			}
			call(map[string]any{"action": "intent", "payload": map[string]any{"intent": "stopped", "request_id": "fixture-stop"}})
			call(map[string]any{"action": "retire", "authority": acquired.Authority, "payload": map[string]any{"attempt_id": next.Claim.AttemptID, "exit_confirmed": true, "pid": 0, "marker": "", "owned_launch": true, "reason": "Fixture never spawned"}})
		})
	}
}

func TestAdminRunnerUnknownAllocationCannotProveStopped(t *testing.T) {
	runner := &Runner{Client: staticRPC(`{"active":[{"attemptId":"unknown"}],"control":{"desired_intent":"stopped"}}`)}
	if runner.Stop(context.Background()) {
		t.Fatal("Missing physical identity was treated as a confirmed stop")
	}
	if err := runner.Tick(context.Background(), "new-host", 2); err == nil {
		t.Fatal("Unknown allocation was silently retired")
	}
}

type staticRPC string

func (s staticRPC) Call(context.Context, any) (json.RawMessage, error) {
	return json.RawMessage(s), nil
}
