package adminrunner

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

// The worker has no database or workflow credentials. It waits for a command on
// its parent's private stdin; only the host persists identity and authorizes it.
type CheckWorkerRequest struct {
	ID            string `json:"id"`
	Command       string `json:"command"`
	WorkspaceRoot string `json:"workspaceRoot"`
}
type CheckWorkerResult struct {
	ID        string `json:"id"`
	ExitCode  *int   `json:"exitCode"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	Truncated bool   `json:"truncated"`
}
type checkOutput struct {
	mu        sync.Mutex
	bytes     []byte
	truncated bool
}

func (w *checkOutput) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	count := len(data)
	remaining := (2 << 20) - len(w.bytes)
	if len(data) > remaining {
		w.truncated = true
		data = data[:remaining]
	}
	w.bytes = append(w.bytes, data...)
	return count, nil
}
func (w *checkOutput) text() (string, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return string(w.bytes), w.truncated
}
func RunVerificationWorker(ctx context.Context, input io.Reader, output io.Writer) error {
	if !nativeChecksSupported() {
		return fmt.Errorf("native verification commands are unsupported on this platform")
	}
	encoder := json.NewEncoder(output)
	if err := encoder.Encode(map[string]string{"kind": "ready"}); err != nil {
		return err
	}
	seen := map[string]bool{}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		var request CheckWorkerRequest
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			return err
		}
		if request.ID == "" || request.Command == "" || request.WorkspaceRoot == "" {
			return fmt.Errorf("native check request is incomplete")
		}
		if seen[request.ID] {
			return fmt.Errorf("native verification command cannot be replayed")
		}
		seen[request.ID] = true
		command := exec.CommandContext(ctx, "/bin/sh", "-c", request.Command)
		command.Dir = request.WorkspaceRoot
		command.WaitDelay = 500 * time.Millisecond
		stdout, stderr := &checkOutput{}, &checkOutput{}
		command.Stdout = stdout
		command.Stderr = stderr
		err := command.Run()
		var code *int
		if err == nil {
			value := 0
			code = &value
		} else {
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				value := exit.ExitCode()
				code = &value
			} else {
				_, _ = stderr.Write([]byte(err.Error()))
			}
		}
		out, outTruncated := stdout.text()
		errOut, errTruncated := stderr.text()
		if err := encoder.Encode(CheckWorkerResult{ID: request.ID, ExitCode: code, Stdout: out, Stderr: errOut, Truncated: outTruncated || errTruncated}); err != nil {
			return err
		}
	}
	return scanner.Err()
}
