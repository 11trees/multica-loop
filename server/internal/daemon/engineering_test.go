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
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

func TestEngineeringEnvironmentBinding(t *testing.T) {
	root := t.TempDir()
	workDir := filepath.Join(root, "workdir")
	if err := os.Mkdir(workDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".multica_sidecar_manifest.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := execenv.InjectRuntimeConfig(workDir, "claude", execenv.TaskContextForEnv{IssueID: "issue"}); err != nil {
		t.Fatal(err)
	}
	var received map[string]any
	response := `{"bound":true}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/daemon/tasks/task/engineering-repository" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(response))
	}))
	defer server.Close()
	d := &Daemon{client: NewClient(server.URL)}
	task := Task{ID: "task", EngineeringChain: "verification", DispatchedAt: "2026-11-13T00:00:00Z"}
	env := &execenv.Environment{RootDir: root, WorkDir: workDir, LocalDirectory: true}
	if err := d.bindEngineeringEnvironment(context.Background(), task, env, "claude"); err != nil {
		t.Fatal(err)
	}
	if received["mode"] != "in_place" || received["work_dir"] != workDir || received["dispatched_at"] != task.DispatchedAt || len(received["overlays"].([]any)) != 1 {
		t.Fatalf("wrong native binding: %+v", received)
	}
	response = `{}`
	if err := d.bindEngineeringEnvironment(context.Background(), task, env, "claude"); err == nil {
		t.Fatal("missing host acknowledgement was accepted")
	}
	env.LocalDirectory = false
	if err := d.bindEngineeringEnvironment(context.Background(), task, env, "claude"); err == nil {
		t.Fatal("unmapped scratch environment was accepted")
	}
}

func TestEngineeringRunTaskBindsBeforeProviderLaunch(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script provider fixture is POSIX-only")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	for _, mode := range []string{localDirectoryModeInPlace, localDirectoryModeWorktree} {
		for _, acknowledge := range []bool{true, false} {
			name := mode + "/acknowledged"
			if !acknowledge {
				name = mode + "/rejected"
			}
			t.Run(name, func(t *testing.T) {
				repo := createDaemonTestRepo(t)
				commitBytes, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
				if err != nil {
					t.Fatal(err)
				}
				commit := strings.TrimSpace(string(commitBytes))
				capture := filepath.Join(t.TempDir(), "provider-cwd")
				marker := filepath.Join(t.TempDir(), "binding-acknowledged")
				fake := filepath.Join(t.TempDir(), "claude-fixture")
				writeTestExecutable(t, fake, []byte(`#!/bin/sh
case "$*" in *--version*) echo '1.0.0'; exit 0;; esac
test -f "$BINDING_ACK" || exit 5
pwd > "$CAPTURE_CWD"
IFS= read -r _
printf '%s\n' '{"type":"system","session_id":"engineering-session"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"engineering-session","result":"fixture done"}'
`))
				started, bound := false, false
				var canonicalWorkDir string
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					if strings.HasSuffix(r.URL.Path, "/start") {
						started = true
					}
					if strings.HasSuffix(r.URL.Path, "/engineering-repository") {
						var input struct {
							WorkDir  string                       `json:"work_dir"`
							Mode     string                       `json:"mode"`
							Claim    string                       `json:"dispatched_at"`
							Overlays []execenv.EngineeringOverlay `json:"overlays"`
						}
						if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
							t.Error(err)
						}
						if !started || input.Mode != mode || input.Claim != "2026-11-13T00:00:00Z" || len(input.Overlays) == 0 {
							t.Errorf("binding was not prepared for current claim: %+v", input)
						}
						var pathErr error
						canonicalWorkDir, pathErr = filepath.EvalSymlinks(input.WorkDir)
						if pathErr != nil {
							t.Error(pathErr)
						}
						if acknowledge {
							if err := os.WriteFile(marker, []byte("acknowledged"), 0600); err != nil {
								t.Error(err)
							}
							bound = true
							w.Write([]byte(`{"bound":true}`))
							return
						}
					}
					w.Write([]byte(`{}`))
				}))
				defer server.Close()
				logger := slog.New(slog.NewTextHandler(io.Discard, nil))
				d := &Daemon{client: NewClient(server.URL), logger: logger, localPathLocks: NewLocalPathLocker(), workspaces: make(map[string]*workspaceState), activeEnvRoots: make(map[string]int),
					cfg: Config{DaemonID: "engineering-daemon", WorkspacesRoot: t.TempDir(), AgentTimeout: 5 * time.Second, ServerBaseURL: server.URL, Agents: map[string]AgentEntry{"claude": {Path: fake}}},
				}
				resource, _ := json.Marshal(localDirectoryRef{LocalPath: repo, DaemonID: d.cfg.DaemonID, ExecutionMode: mode})
				task := Task{ID: "11112222-3333-4444-5555-666677778888", WorkspaceID: "engineering-workspace", IssueID: "engineering-issue", RuntimeID: "engineering-runtime", AgentID: "engineering-agent", AuthToken: "mat_fixture",
					EngineeringChain: "verification", EngineeringRepository: repo, EngineeringCommit: commit, DispatchedAt: "2026-11-13T00:00:00Z",
					Agent:            &AgentData{ID: "engineering-agent", Name: "Verifier", CustomEnv: map[string]string{"CAPTURE_CWD": capture, "BINDING_ACK": marker}},
					ProjectResources: []ProjectResourceData{{ID: "engineering-resource", ResourceType: localDirectoryResourceType, ResourceRef: resource}},
				}
				result, err := d.runTask(context.Background(), task, "claude", 0, logger)
				if !acknowledge {
					if err == nil {
						t.Fatal("provider launch survived a rejected binding")
					}
					if _, err := os.Stat(capture); !os.IsNotExist(err) {
						t.Fatal("provider was launched without a binding")
					}
					return
				}
				if err != nil || result.Status != "completed" || !bound {
					t.Fatalf("native bound execution failed: %+v, %v", result, err)
				}
				cwd, err := os.ReadFile(capture)
				if err != nil {
					t.Fatal(err)
				}
				if mode == localDirectoryModeWorktree {
					if result.BranchName == "" {
						t.Fatal("native pinned execution lost its retained branch")
					}
				}
				if strings.TrimSpace(string(cwd)) != canonicalWorkDir {
					t.Fatalf("provider ran in another directory: %q vs %q", cwd, canonicalWorkDir)
				}
			})
		}
	}
}
