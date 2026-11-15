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

func TestEngineeringCodexPhysicalJournalCompletesBeforeNativeResult(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake executable")
	}
	for _, rejectExit := range []bool{false, true} {
		t.Run(map[bool]string{false: "confirmed", true: "receipt-rejected"}[rejectExit], func(t *testing.T) {
			home := t.TempDir()
			for _, key := range []string{"HOME", "USERPROFILE", "CODEX_HOME"} {
				t.Setenv(key, home)
			}
			fake := writeFakeCodexAppServer(t, `read line
echo '{"id":1,"result":{}}'
read line
read line
echo '{"id":2,"result":{"thread":{"id":"fixture-thread"}}}'
read line
echo '{"id":3,"result":{"turn":{"id":"fixture-turn","status":"inProgress"}}}'
echo '{"method":"turn/started","params":{"threadId":"fixture-thread","turn":{"id":"fixture-turn"}}}'
echo '{"method":"turn/completed","params":{"threadId":"fixture-thread","turn":{"id":"fixture-turn","status":"completed"}}}'
while read line; do :; done
`)
			events := make(chan string, 3)
			pid := 0
			cfg := Config{ExecutablePath: fake, CodexVersion: "fixture", Env: map[string]string{"HOME": home, "CODEX_HOME": home}, OnProcessStarting: func() error { events <- "reserved"; return nil }, OnProcessStarted: func(value int) error { pid = value; events <- "bound"; return nil }, OnProcessExited: func(value int, confirmed bool) error {
				if value != pid || !confirmed {
					t.Errorf("SDK exit proof changed: pid=%d confirmed=%t", value, confirmed)
				}
				events <- "exited"
				if rejectExit {
					return errors.New("fixture receipt was not persisted")
				}
				return nil
			}}
			result, _ := executeFakeCodexCollectingMessagesWithConfig(t, fake, cfg, ExecOptions{Cwd: home}, 10*time.Second)
			for _, want := range []string{"reserved", "bound", "exited"} {
				select {
				case got := <-events:
					if got != want {
						t.Fatalf("Lifecycle = %s; expected %s", got, want)
					}
				default:
					t.Fatalf("Native result arrived before %s", want)
				}
			}
			if rejectExit {
				if result.Status != "cleanup_unconfirmed" {
					t.Fatalf("Lost receipt was treated as safe completion: %+v", result)
				}
			} else if result.Status != "completed" {
				t.Fatalf("Confirmed fixture failed: %+v", result)
			}
		})
	}
}

func TestEngineeringCodexRejectedReservationNeverSpawns(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake executable")
	}
	home := t.TempDir()
	marker := filepath.Join(home, "spawned")
	fake := writeFakeCodexAppServer(t, "touch '"+strings.ReplaceAll(marker, "'", "'\\''")+"'\n")
	exited := false
	backend, err := New("codex", Config{ExecutablePath: fake, CodexVersion: "fixture", Env: map[string]string{"HOME": home, "CODEX_HOME": home}, OnProcessStarting: func() error { return errors.New("fixture reservation rejected") }, OnProcessExited: func(pid int, confirmed bool) error { exited = pid == 0 && confirmed; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	_, err = backend.Execute(context.Background(), "Do not deliver this prompt", ExecOptions{Cwd: home})
	if err == nil || !strings.Contains(err.Error(), "reservation rejected") || !exited {
		t.Fatalf("Reservation rejection changed: %v", err)
	}
	if _, err = os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Rejected reservation still spawned a process")
	}
}

func TestEngineeringCodexEarlyFailureKeepsUnconfirmedExitBarrier(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake executable")
	}
	home := t.TempDir()
	for _, key := range []string{"HOME", "USERPROFILE", "CODEX_HOME"} {
		t.Setenv(key, home)
	}
	fake := writeFakeCodexAppServer(t, "exit 0\n")
	result, _ := executeFakeCodexCollectingMessagesWithConfig(t, fake, Config{CodexVersion: "fixture", Env: map[string]string{"HOME": home, "CODEX_HOME": home}, OnProcessExited: func(int, bool) error { return errors.New("fixture exit receipt lost") }}, ExecOptions{Cwd: home}, 10*time.Second)
	if result.Status != "cleanup_unconfirmed" || result.ResumeRejected || result.codexInitializeRetrySafe || result.codexStartupRefreshRetrySafe {
		t.Fatalf("Early failure lost its physical barrier: %+v", result)
	}
}
