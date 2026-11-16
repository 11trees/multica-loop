//go:build darwin || linux

package adminrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestNativeVerificationWorkerFixture(t *testing.T) {
	if os.Getenv("MULTICA_FIXTURE_VERIFICATION_WORKER") != "1" {
		return
	}
	if os.Getenv("MULTICA_ADMIN_TOKEN") != "" || os.Getenv("MULTICA_TOKEN") != "" || os.Getenv("DATABASE_URL") != "" {
		os.Exit(92)
	}
	if err := RunVerificationWorker(context.Background(), os.Stdin, os.Stdout); err != nil {
		os.Exit(93)
	}
	os.Exit(0)
}

func TestNativeWorkerRefusesDuplicateCommandsAndBoundsActualOutput(t *testing.T) {
	directory := t.TempDir()
	request := CheckWorkerRequest{ID: "same-check", Command: "printf x >> once.txt", WorkspaceRoot: directory}
	raw, _ := json.Marshal(request)
	input := bytes.NewBuffer(append(append(append([]byte(nil), raw...), '\n'), append(raw, '\n')...))
	var output bytes.Buffer
	if err := RunVerificationWorker(context.Background(), input, &output); err == nil {
		t.Fatal("duplicate command was replayed")
	}
	data, err := os.ReadFile(filepath.Join(directory, "once.txt"))
	if err != nil || string(data) != "x" {
		t.Fatal("check side effect repeated", err, string(data))
	}
	capture := &checkOutput{}
	data = bytes.Repeat([]byte("z"), (2<<20)+10)
	if n, err := capture.Write(data); err != nil || n != len(data) {
		t.Fatal("output capture blocked its producer")
	}
	text, truncated := capture.text()
	if len(text) != (2<<20) || !truncated {
		t.Fatal("evidence overflow was not bounded and marked")
	}
}
