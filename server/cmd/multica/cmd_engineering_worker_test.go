package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestEngineeringVerificationWorkerRequiresCredentialFreeContext(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("native process groups")
	}
	command, _, err := engineeringCmd.Find([]string{"verification-worker"})
	if err != nil {
		t.Fatal(err)
	}
	command.SetContext(context.Background())
	t.Setenv("MULTICA_TOKEN", "")
	t.Setenv("MULTICA_ADMIN_TOKEN", "")
	if err = command.RunE(command, nil); err == nil {
		t.Fatal("worker accepted an unscoped human invocation")
	}
	t.Setenv("MULTICA_VERIFICATION_INPUT", filepath.Join(t.TempDir(), "original-facts.json"))
	t.Setenv("MULTICA_TOKEN", "human")
	if err = command.RunE(command, nil); err == nil {
		t.Fatal("worker accepted human credentials")
	}
	t.Setenv("MULTICA_TOKEN", "")
	root := t.TempDir()
	request, _ := json.Marshal(map[string]string{"id": "actual-cli-check", "command": "printf actual-check", "workspaceRoot": root})
	command.SetIn(bytes.NewReader(append(request, '\n')))
	var output bytes.Buffer
	command.SetOut(&output)
	defer command.SetIn(os.Stdin)
	defer command.SetOut(os.Stdout)
	if err = command.RunE(command, nil); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&output)
	var ready struct {
		Kind string `json:"kind"`
	}
	if err = decoder.Decode(&ready); err != nil || ready.Kind != "ready" {
		t.Fatal("missing worker readiness", err)
	}
	var result struct {
		ID       string `json:"id"`
		ExitCode *int   `json:"exitCode"`
		Stdout   string `json:"stdout"`
	}
	if err = decoder.Decode(&result); err != nil || result.ID != "actual-cli-check" || result.ExitCode == nil || *result.ExitCode != 0 || result.Stdout != "actual-check" {
		t.Fatal("CLI did not execute the actual shell check", err)
	}
}
