package adminrunner

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/engineering/processidentity"
)

type nativePlanCheck struct {
	TargetRef string `json:"targetRef"`
	Command   string `json:"command"`
}
type nativeCheckPlan struct {
	ExpectedVersion  string                `json:"expectedVersion"`
	Artifacts        verificationArtifacts `json:"artifacts"`
	Reproduction     nativePlanCheck       `json:"reproduction"`
	AcceptanceChecks []nativePlanCheck     `json:"acceptanceChecks"`
}
type nativeCheckStep struct {
	Ordinal   int    `json:"ordinal"`
	Kind      string `json:"kind"`
	TargetRef string `json:"targetRef"`
	Command   string `json:"command"`
}
type nativeCheckReceipt struct {
	ExitCode           *int   `json:"exitCode"`
	Stdout             string `json:"stdout"`
	Stderr             string `json:"stderr"`
	ExitConfirmed      bool   `json:"exitConfirmed"`
	Truncated          bool   `json:"truncated"`
	ScopeConfirmed     bool   `json:"scopeConfirmed"`
	ArtifactsUnchanged bool   `json:"artifactsUnchanged"`
	WorkerPID          int    `json:"workerPID"`
	WorkerMarker       string `json:"workerMarker"`
}

func verifyArtifacts(ctx context.Context, expected verificationArtifacts) error {
	actual, err := readVerificationArtifacts(ctx, expected.Directory)
	if err != nil {
		return err
	}
	if actual.Directory != expected.Directory || actual.Hash != expected.Hash {
		return fmt.Errorf("frozen independent check artifacts changed")
	}
	return nil
}
func verifyPlanWitness(plan *nativeCheckPlan) error {
	data, err := os.ReadFile(filepath.Join(plan.Artifacts.Directory, "verification-plan.json"))
	if err != nil {
		return err
	}
	if len(data) > 2<<20 {
		return fmt.Errorf("independent plan witness exceeds its input bound")
	}
	var authored struct {
		Reproduction     nativePlanCheck   `json:"reproduction"`
		AcceptanceChecks []nativePlanCheck `json:"acceptanceChecks"`
	}
	if err = json.Unmarshal(data, &authored); err != nil {
		return err
	}
	if authored.Reproduction != plan.Reproduction || len(authored.AcceptanceChecks) != len(plan.AcceptanceChecks) {
		return fmt.Errorf("independent plan differs from its retained original witness")
	}
	for index, check := range authored.AcceptanceChecks {
		if check != plan.AcceptanceChecks[index] {
			return fmt.Errorf("independent check command differs from its retained original witness")
		}
	}
	return nil
}
func nativeCheckOK(step nativeCheckStep, result nativeCheckReceipt, expected string) bool {
	return result.ExitCode != nil && *result.ExitCode == 0 && result.ExitConfirmed && !result.Truncated && result.ScopeConfirmed && result.ArtifactsUnchanged && ((step.Kind != "version-before" && step.Kind != "version-after") || strings.TrimSpace(result.Stdout) == expected)
}
func (r *Runner) executeIndependentChecks(ctx context.Context, run *invocation) (reason string) {
	reason = "Native independent verification failed before checks"
	var process *exec.Cmd
	var stdin io.WriteCloser
	var waited chan error
	var log *os.File
	defer func() {
		run.mu.Lock()
		pid, marker := run.pid, run.marker
		run.mu.Unlock()
		confirmed := pid == 0
		if pid > 0 && marker != "" {
			stop, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			confirmed = processidentity.StopRecorded(stop, pid, marker)
			cancel()
		}
		if stdin != nil {
			_ = stdin.Close()
		}
		if waited != nil {
			select {
			case <-waited:
			case <-time.After(2 * time.Second):
				confirmed = false
			}
		}
		if log != nil {
			defer log.Close()
		}
		finalGate, gateCancel := context.WithTimeout(context.Background(), 10*time.Second)
		scopeErr := r.verificationScope(finalGate, run.claim)
		gateCancel()
		if scopeErr != nil {
			reason = "Final native source authorization failed: " + scopeErr.Error()
		}
		persist, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := r.Client.Call(persist, map[string]any{"action": "verification-compile", "claim": run.claim, "worker_exit_confirmed": confirmed, "native_scope_confirmed": scopeErr == nil, "reason": reason}); err != nil {
			reason = "Native verification receipt could not be committed: " + err.Error()
		}
	}()
	if err := r.verificationScope(ctx, run.claim); err != nil {
		return err.Error()
	}
	view, err := r.verificationView(ctx, run.claim, true)
	if err != nil {
		return err.Error()
	}
	if view.Plan == nil {
		return "Native verification has no frozen independent plan"
	}
	plan := view.Plan
	if err = verifyArtifacts(ctx, plan.Artifacts); err != nil {
		return err.Error()
	}
	if err = verifyPlanWitness(plan); err != nil {
		return err.Error()
	}
	var input struct {
		Binding struct {
			Root string `json:"workspaceRoot"`
		} `json:"workspaceBinding"`
	}
	if err = json.Unmarshal(view.Input, &input); err != nil || !filepath.IsAbs(input.Binding.Root) {
		return "Native verification workspace is invalid"
	}
	if !filepath.IsAbs(r.Multica) {
		return "Native verification requires the explicit host executable"
	}
	if err = os.MkdirAll(r.Root, 0700); err != nil {
		return err.Error()
	}
	log, err = os.OpenFile(filepath.Join(r.Root, run.claim.AttemptID+".log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err.Error()
	}
	outputParent := filepath.Join(r.Root, "verification-runs")
	if err = os.MkdirAll(outputParent, 0700); err != nil {
		return err.Error()
	}
	outputDirectory := filepath.Join(outputParent, run.claim.AttemptID)
	if err = os.Mkdir(outputDirectory, 0700); err != nil {
		return "Native check outputs require a new private directory"
	}
	// Retain outputs outside both frozen inputs and the actual project source.
	process = nativeWorkerCommand(r.Multica)
	environment := adminProviderEnvironment()
	environment["NODE_OPTIONS"] = ""
	environment["MULTICA_VERIFICATION_INPUT"] = filepath.Join(plan.Artifacts.Directory, "original-facts.json")
	environment["TMPDIR"] = outputDirectory
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if replacement, found := environment[key]; found {
			value = replacement
			delete(environment, key)
		}
		process.Env = append(process.Env, key+"="+value)
	}
	for key, value := range environment {
		process.Env = append(process.Env, key+"="+value)
	}
	process.Stderr = log
	stdin, err = process.StdinPipe()
	if err != nil {
		return err.Error()
	}
	stdout, err := process.StdoutPipe()
	if err != nil {
		return err.Error()
	}
	if err = process.Start(); err != nil {
		return err.Error()
	}
	waited = make(chan error, 1)
	go func() { waited <- process.Wait() }()
	if err = r.bindProcess(ctx, run, process.Process.Pid); err != nil {
		return err.Error()
	}
	replies := make(chan json.RawMessage, 1)
	readErrors := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4096), 32<<20)
		for scanner.Scan() {
			select {
			case replies <- append(json.RawMessage(nil), scanner.Bytes()...):
			case <-ctx.Done():
				return
			}
		}
		err := scanner.Err()
		if err == nil {
			err = io.EOF
		}
		readErrors <- err
	}()
	receive := func(timeout time.Duration) (json.RawMessage, error) {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		select {
		case reply := <-replies:
			return reply, nil
		case err := <-readErrors:
			return nil, err
		case <-timer.C:
			return nil, fmt.Errorf("native verification command timed out")
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	ready, err := receive(10 * time.Second)
	if err != nil {
		return err.Error()
	}
	var initial struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(ready, &initial) != nil || initial.Kind != "ready" {
		return "Native worker did not complete its private handshake"
	}
	run.mu.Lock()
	pid, marker := run.pid, run.marker
	run.mu.Unlock()
	if !onlyNativeWorker(ctx, pid, marker) {
		return "Native worker baseline contains unknown processes"
	}
	total := len(plan.AcceptanceChecks) + 3
	for ordinal := 0; ordinal < total; ordinal++ {
		if err = r.verificationScope(ctx, run.claim); err != nil {
			return err.Error()
		}
		if err = verifyArtifacts(ctx, plan.Artifacts); err != nil {
			return err.Error()
		}
		raw, err := r.Client.Call(ctx, map[string]any{"action": "verification-check-start", "claim": run.claim, "ordinal": ordinal})
		if err != nil {
			return err.Error()
		}
		var step nativeCheckStep
		if err = json.Unmarshal(raw, &step); err != nil {
			return err.Error()
		}
		result := nativeCheckReceipt{WorkerPID: pid, WorkerMarker: marker}
		if step.Kind == "version-before" || step.Kind == "version-after" {
			scopeErr := r.verificationScope(ctx, run.claim)
			raw, readErr := r.Client.Call(ctx, map[string]any{"action": "verification-current", "claim": run.claim})
			var current struct {
				Progress struct {
					Version *string `json:"workspace_version"`
				} `json:"progress"`
			}
			if readErr == nil {
				readErr = json.Unmarshal(raw, &current)
			}
			if scopeErr == nil && readErr == nil && current.Progress.Version != nil {
				zero := 0
				result.ExitCode = &zero
				result.Stdout = *current.Progress.Version
			}
			if scopeErr != nil {
				result.Stderr = scopeErr.Error()
			} else if readErr != nil {
				result.Stderr = readErr.Error()
			}
		} else {
			request := CheckWorkerRequest{ID: fmt.Sprintf("check-%d", ordinal), Command: step.Command, WorkspaceRoot: input.Binding.Root}
			if err = json.NewEncoder(stdin).Encode(request); err != nil {
				return err.Error()
			}
			timeout := r.CheckTimeout
			if timeout <= 0 {
				timeout = 20 * time.Minute
			}
			reply, commandErr := receive(timeout)
			if commandErr != nil {
				result.Stderr = commandErr.Error()
				stop, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				result.ExitConfirmed = processidentity.StopRecorded(stop, pid, marker)
				cancel()
			} else {
				var captured CheckWorkerResult
				if err = json.Unmarshal(reply, &captured); err != nil || captured.ID != request.ID {
					return "Native worker result does not match the durably started command"
				}
				result.ExitCode = captured.ExitCode
				result.Stdout = captured.Stdout
				result.Stderr = captured.Stderr
				result.Truncated = captured.Truncated
			}
		}
		if !result.ExitConfirmed {
			deadline := time.Now().Add(500 * time.Millisecond)
			for {
				if onlyNativeWorker(ctx, pid, marker) {
					result.ExitConfirmed = true
					break
				}
				if ctx.Err() != nil || time.Now().After(deadline) {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
		}
		result.ScopeConfirmed = r.verificationScope(ctx, run.claim) == nil
		result.ArtifactsUnchanged = verifyArtifacts(ctx, plan.Artifacts) == nil
		capture, _ := json.Marshal(map[string]any{"step": step, "result": result})
		_, _ = log.Write(append(capture, '\n'))
		persist, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, err = r.Client.Call(persist, map[string]any{"action": "verification-check-result", "claim": run.claim, "payload": map[string]any{"ordinal": ordinal, "result": result}})
		cancel()
		if err != nil {
			return err.Error()
		}
		if !nativeCheckOK(step, result, plan.ExpectedVersion) {
			return fmt.Sprintf("Independent %s/%s failed or lacks unchanged inputs and physical exit", step.Kind, step.TargetRef)
		}
	}
	return "Original reproduction, every acceptance and before/after versions executed; business handoff remains required"
}
