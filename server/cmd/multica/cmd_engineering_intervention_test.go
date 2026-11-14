package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestEngineeringInterventionFilesPreserveOriginalEvidence(t *testing.T) {
	t.Chdir(t.TempDir())
	clearDaemonTaskEnv(t)
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	values := map[string]string{"summary": "请求介入", "reason": "冻结契约与入口矛盾", "evidence": "# 原始调查\n\n- 保留原始 Oracle。"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/engineering/intervention/request" {
			t.Errorf("wrong intervention endpoint: %s", r.URL.Path)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		for name, value := range values {
			if body[name] != value {
				t.Errorf("changed %s evidence", name)
			}
		}
		fmt.Fprint(w, `{"submitted":true,"agent_action":"end_execution"}`)
	}))
	defer server.Close()
	setCLITestServerEnv(t, server.URL)
	command, _, err := engineeringCmd.Find([]string{"intervention-request"})
	if err != nil {
		t.Fatal(err)
	}
	command.SetContext(context.Background())
	for name, value := range values {
		path := filepath.Join(dir, name+".md")
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		command.Flags().Set(name+"-file", path)
		t.Cleanup(func() { command.Flags().Set(name+"-file", "") })
	}
	if _, err := captureStdout(t, func() error { return command.RunE(command, nil) }); err != nil {
		t.Fatal(err)
	}
}
