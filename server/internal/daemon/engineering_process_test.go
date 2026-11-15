//go:build darwin || linux

package daemon

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/engineering"
)

func TestEngineeringNativeCodexPhysicalLifecycle(t *testing.T) {
	worker, err := filepath.Abs("../../../packages/command-chain/dist/worker.mjs")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(worker); err != nil {
		t.Skip("Build command-chain before the bundled-worker integration")
	}
	for _, failure := range []string{"none", "reserve", "bind", "exit", "end"} {
		t.Run(failure, func(t *testing.T) {
			home := t.TempDir()
			for _, key := range []string{"HOME", "USERPROFILE", "CODEX_HOME"} {
				t.Setenv(key, home)
			}
			repo := createDaemonTestRepo(t)
			commit, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
			if err != nil {
				t.Fatal(err)
			}
			marker, capture := filepath.Join(home, "bound"), filepath.Join(home, "prompt-seen")
			fake := filepath.Join(home, "codex-fixture")
			writeTestExecutable(t, fake, []byte(`#!/bin/sh
case "$*" in *--version*) echo 'codex-cli 0.0.0-fixture';exit 0;;esac
read line
test -f "$PHYSICAL_BINDING_ACK" || exit 5
printf '%s\n' '{"id":1,"result":{}}'
read line
read line
printf '%s\n' '{"id":2,"result":{"thread":{"id":"fixture-thread"}}}'
read line
printf 'seen' > "$PROMPT_CAPTURE"
printf '%s\n' '{"id":3,"result":{"turn":{"id":"fixture-turn","status":"inProgress"}}}'
printf '%s\n' '{"method":"turn/started","params":{"threadId":"fixture-thread","turn":{"id":"fixture-turn"}}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"fixture-thread","turn":{"id":"fixture-turn","status":"completed"}}}'
while read line;do :;done
`))
			workspaceID, issueID, agentID, projectID, userID, runtimeID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			taskID := uuid.NewString()
			claim := "2026-11-15T00:00:00Z"
			app := &engineering.Client{Worker: worker, Database: filepath.Join(home, "engineering.sqlite")}
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cancel()
			if _, err = app.Call(ctx, map[string]any{"actor": map[string]any{"kind": "human", "workspaceId": workspaceID, "issueId": issueID, "userId": userID}, "action": "configure-direct", "payload": map[string]any{"expected_revision": 0, "agent_id": agentID, "project_id": projectID, "repository_path": repo, "input": "Preserve original evidence", "execution_resources": []map[string]any{{"path": repo, "mode": "in_place"}}}}); err != nil {
				t.Fatal(err)
			}
			nativeActor := map[string]any{"kind": "daemon", "workspaceId": workspaceID, "issueId": issueID, "agentId": agentID, "projectId": projectID, "attemptId": taskID}
			// Derive the exact native claim in the same units as the real API.
			parsed, _ := time.Parse(time.RFC3339Nano, claim)
			nativeActor["attemptId"] = taskID + ":" + strconv.FormatInt(parsed.UnixMicro(), 10)
			operations := make(chan string, 20)
			processPhase, controllerID := "", ""
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case strings.HasSuffix(r.URL.Path, "/engineering-repository"):
					var payload map[string]any
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
						t.Error(err)
						http.Error(w, "bad request", 400)
						return
					}
					delete(payload, "dispatched_at")
					result, err := app.Call(ctx, map[string]any{"actor": nativeActor, "action": "bind", "payload": payload})
					if err != nil {
						t.Error(err)
						http.Error(w, "binding rejected", 409)
						return
					}
					_, _ = w.Write(result)
				case strings.HasSuffix(r.URL.Path, "/engineering-controller"):
					var payload map[string]any
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
						t.Error(err)
						return
					}
					if payload["dispatched_at"] != claim {
						t.Error("Physical claim changed")
					}
					op, _ := payload["operation"].(string)
					operations <- op
					if op == "begin" {
						controllerID, _ = payload["controller_id"].(string)
					}
					if controllerID == "" || controllerID != payload["controller_id"] || payload["host_id"] == "" {
						t.Error("Controller identity changed")
					}
					switch op {
					case "begin":
						if payload["provider"] != "codex" || payload["pid"] != float64(os.Getpid()) || payload["marker"] == "" {
							t.Error("Missing native controller identity")
						}
						_, _ = w.Write([]byte(`{"admitted":true}`))
					case "workspace":
						root, _ := filepath.EvalSymlinks(repo)
						actual, _ := filepath.EvalSymlinks(payload["workspace_path"].(string))
						if actual != root || payload["mode"] != "in_place" {
							t.Error("Actual workspace was not bound before launch")
						}
						_, _ = w.Write([]byte(`{"bound":true}`))
					case "process-reserve":
						processPhase = "launching"
						if failure == "reserve" {
							http.Error(w, "fixture acknowledgement lost", 409)
							return
						}
						_, _ = w.Write([]byte(`{"reserved":true,"status":"launching"}`))
					case "process-bind":
						processPhase = "running"
						if payload["pid"] != payload["group_id"] || payload["marker"] == "" {
							t.Error("Missing physical group identity")
						}
						if failure == "bind" {
							http.Error(w, "fixture admission closed after PID recorded", 409)
							return
						}
						if err := os.WriteFile(marker, []byte("bound"), 0600); err != nil {
							t.Error(err)
						}
						_, _ = w.Write([]byte(`{"bound":true}`))
					case "process-exit":
						if failure == "exit" {
							http.Error(w, "fixture acknowledgement lost", 409)
							return
						}
						if payload["exit_confirmed"] != true {
							t.Error("Fixture did not physically stop")
						}
						processPhase = "exited"
						_, _ = w.Write([]byte(`{"exited":true}`))
					case "end":
						if failure == "end" {
							http.Error(w, "fixture cleanup acknowledgement lost", 409)
							return
						}
						if payload["no_provider_started"] != (failure == "reserve") {
							t.Error("Controller cleanup invented its no-spawn fact")
						}
						_ = json.NewEncoder(w).Encode(map[string]any{"recorded": true, "quiesced": processPhase == "exited"})
					default:
						t.Errorf("Unknown controller operation %s", op)
					}
				default:
					_, _ = w.Write([]byte(`{}`))
				}
			}))
			defer server.Close()
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			d := &Daemon{client: NewClient(server.URL), logger: logger, localPathLocks: NewLocalPathLocker(), workspaces: make(map[string]*workspaceState), activeEnvRoots: make(map[string]int), activeStores: make(map[string]int), deletingStores: make(map[string]bool), cfg: Config{DaemonID: "fixture-daemon", WorkspacesRoot: t.TempDir(), AgentTimeout: 15 * time.Second, ServerBaseURL: server.URL, Agents: map[string]AgentEntry{"codex": {Path: fake}}}}
			d.activeStoresCond = sync.NewCond(&d.activeStoresMu)
			resource, _ := json.Marshal(localDirectoryRef{LocalPath: repo, DaemonID: d.cfg.DaemonID, ExecutionMode: localDirectoryModeInPlace})
			task := Task{ID: taskID, WorkspaceID: workspaceID, IssueID: issueID, RuntimeID: runtimeID, AgentID: agentID, AuthToken: "mat_fixture", EngineeringOwnership: true, EngineeringChain: "direct", EngineeringRepository: repo, EngineeringCommit: strings.TrimSpace(string(commit)), DispatchedAt: claim, Agent: &AgentData{ID: agentID, Name: "Fixture", CustomEnv: map[string]string{"PHYSICAL_BINDING_ACK": marker, "PROMPT_CAPTURE": capture}}, ProjectResources: []ProjectResourceData{{ID: uuid.NewString(), ResourceType: localDirectoryResourceType, ResourceRef: resource}}}
			result, runErr := d.runTask(ctx, task, "codex", 0, logger)
			if runErr != nil && failure != "reserve" && failure != "bind" {
				t.Fatalf("Native fixture failed: %+v %v", result, runErr)
			}
			expected := "completed"
			if failure == "exit" || failure == "end" {
				expected = "blocked"
			}
			if failure == "bind" || failure == "reserve" {
				expected = ""
				if runErr == nil {
					t.Fatal("Rejected launch did not fail its native execution")
				}
			}
			if result.Status != expected {
				t.Fatalf("Native result=%+v; expected %s", result, expected)
			}
			if expected == "blocked" && result.FailureReason != "cleanup_unconfirmed" {
				t.Fatalf("Missing native cleanup barrier: %+v", result)
			}
			if failure == "reserve" || failure == "bind" {
				if _, err = os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("Rejected launch delivered a prompt")
				}
			}
			want := []string{"begin", "workspace", "process-reserve", "process-bind", "process-exit", "end"}
			if failure == "reserve" {
				want = []string{"begin", "workspace", "process-reserve", "process-exit", "end"}
			}
			for _, op := range want {
				select {
				case got := <-operations:
					if got != op {
						t.Fatalf("Lifecycle=%s, expected %s", got, op)
					}
				default:
					t.Fatalf("Native result preceded %s receipt", op)
				}
			}
			select {
			case extra := <-operations:
				t.Fatalf("Unexpected lifecycle operation %s", extra)
			default:
			}
			if failure == "exit" && processPhase != "running" {
				t.Fatal("Lost exit acknowledgement released its allocation")
			}

		})
	}
}
