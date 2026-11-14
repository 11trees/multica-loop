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

func TestEngineeringDirectFileSubmissionPreservesMarkdownAndUsesItsOwnEndpoint(t *testing.T) {
	t.Chdir(t.TempDir())
	clearDaemonTaskEnv(t)
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	summary := filepath.Join(dir, "summary.txt")
	result := filepath.Join(dir, "result.md")
	if err := os.WriteFile(summary, []byte("摘要已完成"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(result, []byte("# 原始资料\n\n- 保留事实。"), 0600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/engineering/direct/submit" {
			t.Errorf("wrong Direct endpoint: %s", r.URL.Path)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["summary"] != "摘要已完成" || body["result"] != "# 原始资料\n\n- 保留事实。" {
			t.Error("Direct file content changed")
		}
		fmt.Fprint(w, `{"direct":{"result":{"id":"result"}}}`)
	}))
	defer server.Close()
	setCLITestServerEnv(t, server.URL)
	cmd, _, err := engineeringCmd.Find([]string{"direct-submit"})
	if err != nil {
		t.Fatal(err)
	}
	cmd.SetContext(context.Background())
	cmd.Flags().Set("summary-file", summary)
	cmd.Flags().Set("result-file", result)
	t.Cleanup(func() { cmd.Flags().Set("summary-file", ""); cmd.Flags().Set("result-file", "") })
	if _, err := captureStdout(t, func() error { return cmd.RunE(cmd, nil) }); err != nil {
		t.Fatal(err)
	}
}

func TestEngineeringDirectFilesStayInsideTaskTempAndRejectNonUTF8(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	outside := filepath.Join(t.TempDir(), "outside.md")
	os.WriteFile(outside, []byte("Outside"), 0600)
	if _, err := readEngineeringTaskText(outside, 4000); err == nil {
		t.Fatal("external Direct input was read")
	}
	link := filepath.Join(dir, "linked.md")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readEngineeringTaskText(link, 4000); err == nil {
		t.Fatal("Direct symlink escaped task temp")
	}
	invalid := filepath.Join(dir, "invalid.md")
	os.WriteFile(invalid, []byte{0xff}, 0600)
	if _, err := readEngineeringTaskText(invalid, 4000); err == nil {
		t.Fatal("invalid UTF-8 submitted")
	}
}
