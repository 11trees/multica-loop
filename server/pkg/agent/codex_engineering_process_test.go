package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestEngineeringCodexRejectedProcessBindingStopsBeforeProtocolInitialization(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake executable fixture")
	}
	root := t.TempDir()
	executable := filepath.Join(root, "codex-fixture")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\nexec /bin/sleep 30\n"), 0700); err != nil {
		t.Fatal(err)
	}
	pid := 0
	backend, err := New("codex", Config{ExecutablePath: executable, CodexVersion: "fixture", Env: map[string]string{"HOME": root, "USERPROFILE": root, "CODEX_HOME": root}, OnProcessStarted: func(value int) error { pid = value; return errors.New("fixture binding rejected") }})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	session, err := backend.Execute(ctx, "No prompt may reach this fixture", ExecOptions{Cwd: root})
	if err == nil || !strings.Contains(err.Error(), "fixture binding rejected") || session != nil || pid <= 0 {
		t.Fatalf("rejected process binding survived: %v", err)
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	if err = process.Signal(syscall.Signal(0)); !errors.Is(err, syscall.ESRCH) && !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("rejected fixture process exit is unconfirmed: %v", err)
	}
}
