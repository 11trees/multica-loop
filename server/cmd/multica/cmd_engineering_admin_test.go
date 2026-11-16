package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestEngineeringAdminPrivateCommandUsesInvocationSocketWithoutHumanProfile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix invocation socket")
	}
	root, err := os.MkdirTemp("", "admin-cli-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	socket := filepath.Join(root, "command.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MULTICA_ADMIN_SOCKET", socket)
	t.Setenv("MULTICA_ADMIN_TOKEN", "fixture-private-token")
	t.Setenv("MULTICA_TOKEN", "fixture-human-token-must-not-be-used")
	received := make(chan map[string]any, 1)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/command" || r.Header.Get("Authorization") != "Bearer fixture-private-token" {
			t.Error("Invocation credential projection changed")
			http.Error(w, "unauthorized", 403)
			return
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		received <- payload
		_, _ = w.Write([]byte(`{"agent_action":"investigate"}`))
	})}
	go server.Serve(listener)
	defer server.Close()
	command, _, err := engineeringCmd.Find([]string{"admin", "status"})
	if err != nil {
		t.Fatal(err)
	}
	command.SetContext(context.Background())
	var output bytes.Buffer
	command.SetOut(&output)
	defer command.SetOut(nil)
	if err = command.RunE(command, nil); err != nil {
		t.Fatal(err)
	}
	payload := <-received
	if payload["action"] != "status" || len(payload) != 1 || !bytes.Contains(output.Bytes(), []byte("investigate")) {
		t.Fatalf("Unexpected command payload or output: %v %s", payload, output.String())
	}
	takeover, _, err := engineeringCmd.Find([]string{"admin", "workspace-takeover"})
	if err != nil {
		t.Fatal(err)
	}
	takeover.SetContext(context.Background())
	takeover.SetOut(&output)
	defer takeover.SetOut(nil)
	if err = takeover.Flags().Set("observation-id", "original-observation"); err != nil {
		t.Fatal(err)
	}
	if err = takeover.Flags().Set("reason", "Recover original workspace"); err != nil {
		t.Fatal(err)
	}
	defer takeover.Flags().Set("observation-id", "")
	defer takeover.Flags().Set("reason", "")
	if err = takeover.RunE(takeover, nil); err != nil {
		t.Fatal(err)
	}
	payload = <-received
	if payload["action"] != "workspace-takeover" || payload["observation_id"] != "original-observation" || payload["reason"] != "Recover original workspace" || len(payload) != 3 {
		t.Fatalf("Takeover identity was not host-projected: %v", payload)
	}
	t.Setenv("MULTICA_ADMIN_TOKEN", "")
	if _, err = callAdminCommand(context.Background(), map[string]any{"action": "status"}); err == nil {
		t.Fatal("Human credential was allowed as an invocation fallback")
	}
}

func TestEngineeringAdminManagementIsUnavailableToTaskInvocation(t *testing.T) {
	command, _, err := engineeringCmd.Find([]string{"admin-control", "start"})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MULTICA_ADMIN_TOKEN", "fixture-invocation")
	if _, err = adminWorker(command); err == nil {
		t.Fatal("Investigator obtained local management control")
	}
	t.Setenv("MULTICA_ADMIN_TOKEN", "")
	t.Setenv("MULTICA_TASK_ID", "fixture-native-task")
	if _, err = adminWorker(command); err == nil {
		t.Fatal("Native business task obtained local management control")
	}
}

func TestEngineeringAdminIndependentTestCannotUseHumanCredentials(t *testing.T) {
	for _, marker := range []string{"MULTICA_VERIFICATION_INPUT", "MULTICA_VERIFICATION_RESULT"} {
		t.Run(marker, func(t *testing.T) {
			t.Setenv(marker, filepath.Join(t.TempDir(), "private-test-input"))
			t.Setenv("MULTICA_TOKEN", "human-credential-must-not-be-used")
			command, _, err := engineeringCmd.Find([]string{"admin-control", "start"})
			if err != nil {
				t.Fatal(err)
			}
			if resolveToken(command) != "" {
				t.Fatal("independent Test inherited a member or task token")
			}
			if _, err = adminWorker(command); err == nil {
				t.Fatal("independent Test obtained management access")
			}
			if err = requireHumanLocalCommand("login"); err == nil {
				t.Fatal("independent Test could authenticate as the user")
			}
			if err = requireTaskLocalConfigRoot(); err == nil {
				t.Fatal("independent Test could fall back to the user's config root")
			}
		})
	}
}
