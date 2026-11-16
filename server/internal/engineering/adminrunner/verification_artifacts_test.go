//go:build darwin || linux

package adminrunner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestVerificationArtifactsRetainCompleteTreeAndRejectLinks(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "check.cjs")
	if err = os.WriteFile(file, []byte("Original assertion"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := readVerificationArtifacts(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	same, err := readVerificationArtifacts(context.Background(), root)
	if err != nil || same.Hash != before.Hash {
		t.Fatal("stable artifacts changed", err)
	}
	if err = os.Mkdir(filepath.Join(root, "empty-input-directory"), 0700); err != nil {
		t.Fatal(err)
	}
	changed, err := readVerificationArtifacts(context.Background(), root)
	if err != nil || changed.Hash == before.Hash {
		t.Fatal("empty input directory was not captured", err)
	}
	if err = os.Chmod(file, 0700); err != nil {
		t.Fatal(err)
	}
	executable, err := readVerificationArtifacts(context.Background(), root)
	if err != nil || executable.Hash == changed.Hash {
		t.Fatal("execution mode was not captured", err)
	}
	if err = os.Link(file, filepath.Join(root, "hard-link")); err != nil {
		t.Fatal(err)
	}
	if _, err = readVerificationArtifacts(context.Background(), root); err == nil {
		t.Fatal("hard-linked input accepted")
	}
	if err = os.Remove(filepath.Join(root, "hard-link")); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(file, filepath.Join(root, "symbolic-link")); err != nil {
		t.Fatal(err)
	}
	if _, err = readVerificationArtifacts(context.Background(), root); err == nil {
		t.Fatal("symbolic input accepted")
	}
	if err = os.Remove(filepath.Join(root, "symbolic-link")); err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = readVerificationArtifacts(cancelled, root); err == nil {
		t.Fatal("cancelled artifact capture produced a manifest")
	}
}
func TestRunnerStopCancelsOnlyDurableNeverLaunchedWaitingTests(t *testing.T) {
	for _, status := range []string{"waiting", "launching"} {
		t.Run(status, func(t *testing.T) {
			calls := 0
			r := &Runner{Client: verificationTestRPC{call: func(input any) (json.RawMessage, error) {
				body := input.(map[string]any)
				if body["action"] == "state" {
					return json.Marshal(map[string]any{"control": map[string]any{"owner_id": "current", "fencing_token": 7}, "active": []any{map[string]any{"role": "verification", "status": status, "attemptId": "waiting-original"}}})
				}
				if body["action"] != "verification-wait-cancel" || body["attempt_id"] != "waiting-original" || body["authority"].(authority).Token != 7 {
					t.Fatal("unexpected waiting cancellation")
				}
				calls++
				return json.RawMessage(`{"cancelled":true}`), nil
			}}}
			confirmed := r.Stop(context.Background())
			if status == "waiting" && (!confirmed || calls != 1) {
				t.Fatal("known never-launched Test held an unknown process barrier")
			}
			if status == "launching" && (confirmed || calls != 0) {
				t.Fatal("unknown launched identity was treated as no-spawn")
			}
		})
	}
}
