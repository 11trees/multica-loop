// Package adminrunner owns investigation processes independently of business slots.
package adminrunner

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/engineering/processidentity"
	"github.com/multica-ai/multica/server/pkg/agent"
)

type RPC interface {
	Call(context.Context, any) (json.RawMessage, error)
}
type authority struct {
	OwnerID string `json:"ownerId"`
	Token   int64  `json:"token"`
}
type claim struct {
	Authority  authority `json:"authority"`
	CaseID     string    `json:"caseId"`
	AttemptID  string    `json:"attemptId"`
	Generation int64     `json:"generation"`
	SessionID  string    `json:"sessionId"`
}
type attempt struct {
	Role             string  `json:"role"`
	Status           string  `json:"status"`
	SessionID        string  `json:"sessionId"`
	Generation       int64   `json:"generation"`
	AttemptID        string  `json:"attemptId"`
	CaseID           string  `json:"caseId"`
	OwnerID          string  `json:"ownerId"`
	SupervisionToken int64   `json:"supervisionToken"`
	IntentRevision   int64   `json:"intentRevision"`
	PID              *int    `json:"pid"`
	Marker           *string `json:"startMarker"`
	Runtime          struct {
		Configuration struct {
			Provider        string `json:"provider"`
			ExecutablePath  string `json:"executablePath"`
			Model           string `json:"model"`
			ReasoningEffort string `json:"reasoningEffort"`
		} `json:"configuration"`
	} `json:"runtime"`
}
type invocation struct {
	claim     claim
	attempt   attempt
	cancel    context.CancelFunc
	done      chan struct{}
	mu        sync.Mutex
	pid       int
	marker    string
	confirmed bool
}
type Runner struct {
	Client              RPC
	Multica             string
	Root                string
	PrepareVerification func(context.Context, json.RawMessage) error
	VerifyScope         func(context.Context, json.RawMessage) error
	CheckTimeout        time.Duration
	mu                  sync.Mutex
	active              *invocation
}

func isIndependentVerification(role string) bool {
	return role == "verification" || role == "verification-execution"
}

func (r *Runner) Tick(ctx context.Context, owner string, token int64) error {
	var state struct {
		Control struct {
			Intent   string `json:"desired_intent"`
			Revision int64  `json:"intent_revision"`
		} `json:"control"`
		Active []attempt `json:"active"`
	}
	data, err := r.Client.Call(ctx, map[string]any{"action": "state"})
	if err != nil {
		return err
	}
	if err = json.Unmarshal(data, &state); err != nil {
		return err
	}
	current := authority{OwnerID: owner, Token: token}
	r.mu.Lock()
	running := r.active
	r.mu.Unlock()
	if running != nil {
		if state.Control.Intent != "running" || state.Control.Revision != running.attempt.IntentRevision || running.claim.Authority != current {
			running.cancel()
		}
		select {
		case <-running.done:
			r.mu.Lock()
			if r.active == running {
				r.active = nil
			}
			r.mu.Unlock()
		default:
		}
		return nil
	}
	for _, old := range state.Active {
		if old.Status == "waiting" && isIndependentVerification(old.Role) {
			if state.Control.Intent == "running" && old.OwnerID == current.OwnerID && old.SupervisionToken == current.Token && old.IntentRevision == state.Control.Revision {
				return r.startVerification(ctx, current, old)
			}
			if _, err = r.Client.Call(ctx, map[string]any{"action": "verification-wait-cancel", "authority": current, "attempt_id": old.AttemptID}); err != nil {
				return err
			}
			continue
		}
		if old.PID == nil || old.Marker == nil {
			return fmt.Errorf("Admin allocation %s has unconfirmed process identity", old.AttemptID)
		}
		stopCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		confirmed := processidentity.StopRecorded(stopCtx, *old.PID, *old.Marker)
		cancel()
		if !confirmed {
			return fmt.Errorf("Admin process %s has not confirmed exit", old.AttemptID)
		}
		_, err = r.Client.Call(ctx, map[string]any{"action": "retire", "authority": current, "payload": map[string]any{"attempt_id": old.AttemptID, "exit_confirmed": true, "pid": *old.PID, "marker": *old.Marker, "reason": "Previous Admin invocation physically stopped"}})
		if err != nil {
			return err
		}
	}
	if state.Control.Intent != "running" {
		return nil
	}
	if !processidentity.Supported() {
		return fmt.Errorf("Independent Admin execution is not supported on this platform")
	}
	data, err = r.Client.Call(ctx, map[string]any{"action": "claim", "authority": current})
	if err != nil {
		return err
	}
	if string(data) == "null" {
		return nil
	}
	var allocated struct {
		Claim   claim   `json:"claim"`
		Attempt attempt `json:"attempt"`
	}
	if err = json.Unmarshal(data, &allocated); err != nil || allocated.Claim.AttemptID == "" {
		return fmt.Errorf("invalid Admin allocation")
	}
	if isIndependentVerification(allocated.Attempt.Role) {
		return r.startVerification(ctx, current, allocated.Attempt)
	}
	r.launch(ctx, allocated.Claim, allocated.Attempt)
	return nil
}
func (r *Runner) launch(ctx context.Context, identity claim, attempt attempt) {
	runCtx, cancel := context.WithCancel(ctx)
	run := &invocation{claim: identity, attempt: attempt, cancel: cancel, done: make(chan struct{})}
	r.mu.Lock()
	r.active = run
	r.mu.Unlock()
	go r.execute(runCtx, run)
}
func (r *Runner) Stop(ctx context.Context) bool {
	r.mu.Lock()
	run := r.active
	r.mu.Unlock()
	if run == nil {
		data, err := r.Client.Call(ctx, map[string]any{"action": "state"})
		var state struct {
			Control struct {
				Owner string `json:"owner_id"`
				Token int64  `json:"fencing_token"`
			} `json:"control"`
			Active []attempt `json:"active"`
		}
		if err != nil || json.Unmarshal(data, &state) != nil {
			return false
		}
		for _, old := range state.Active {
			if old.Status != "waiting" || old.Role != "verification" {
				return false
			}
			if _, err = r.Client.Call(ctx, map[string]any{"action": "verification-wait-cancel", "authority": authority{OwnerID: state.Control.Owner, Token: state.Control.Token}, "attempt_id": old.AttemptID}); err != nil {
				return false
			}
		}
		return true
	}
	run.cancel()
	select {
	case <-run.done:
		run.mu.Lock()
		defer run.mu.Unlock()
		return run.confirmed
	case <-ctx.Done():
		return false
	}
}
func (r *Runner) execute(ctx context.Context, run *invocation) {
	defer close(run.done)
	defer run.cancel()
	reason := "Admin invocation ended without a terminal submission"
	secretToken := ""
	defer func() {
		run.mu.Lock()
		pid, marker := run.pid, run.marker
		run.mu.Unlock()
		confirmed := pid == 0 || processidentity.GroupGone(pid)
		run.mu.Lock()
		run.confirmed = confirmed
		run.mu.Unlock()
		settle, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if secretToken != "" {
			reason = strings.ReplaceAll(reason, secretToken, "[REDACTED]")
		}
		_, err := r.Client.Call(settle, map[string]any{"action": "finish", "claim": run.claim, "payload": map[string]any{"exit_confirmed": confirmed, "reason": reason}})
		if err != nil && confirmed {
			_, _ = r.Client.Call(settle, map[string]any{"action": "retire", "authority": run.claim.Authority, "payload": map[string]any{"attempt_id": run.claim.AttemptID, "exit_confirmed": true, "pid": pid, "marker": marker, "owned_launch": true, "reason": reason}})
		}
	}()
	if run.attempt.Role == "verification-execution" {
		reason = r.executeIndependentChecks(ctx, run)
		return
	}
	if run.attempt.Role == "verification" {
		reason = r.prepareIndependentChecks(ctx, run)
		return
	}
	temporary, err := os.MkdirTemp("", "multica-admin-")
	if err != nil {
		reason = err.Error()
		return
	}
	defer func() {
		run.mu.Lock()
		confirmed := run.pid == 0 || processidentity.GroupGone(run.pid)
		run.mu.Unlock()
		if confirmed {
			_ = os.RemoveAll(temporary)
		}
	}()
	if err = os.MkdirAll(r.Root, 0700); err != nil {
		reason = err.Error()
		return
	}
	log, err := os.OpenFile(filepath.Join(r.Root, run.claim.AttemptID+".log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		reason = err.Error()
		return
	}
	defer log.Close()
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		reason = err.Error()
		return
	}
	token := hex.EncodeToString(secret)
	secretToken = token
	tokenHash := sha256.Sum256([]byte(token))
	socket := filepath.Join(temporary, "command.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		reason = err.Error()
		return
	}
	_ = os.Chmod(socket, 0600)
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		received := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
		receivedHash := sha256.Sum256([]byte(received))
		if req.Method != http.MethodPost || req.URL.Path != "/command" || subtle.ConstantTimeCompare(receivedHash[:], tokenHash[:]) != 1 {
			http.Error(w, "invalid Admin command credential", http.StatusForbidden)
			return
		}
		payload, err := io.ReadAll(http.MaxBytesReader(w, req.Body, 32<<20))
		if err != nil || !json.Valid(payload) {
			http.Error(w, "invalid Admin command", http.StatusBadRequest)
			return
		}
		result, err := r.command(req.Context(), run.claim, json.RawMessage(payload))
		if err != nil {
			http.Error(w, strings.ReplaceAll(err.Error(), token, "[REDACTED]"), http.StatusConflict)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(result)
	})}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	environment := adminProviderEnvironment()
	environment["MULTICA_ADMIN_SOCKET"] = socket
	environment["MULTICA_ADMIN_TOKEN"] = token
	environment["MULTICA_ADMIN_MULTICA"] = r.Multica
	environment["TMPDIR"] = temporary
	if run.attempt.Runtime.Configuration.Provider != "codex" {
		reason = "Unsupported Admin provider"
		return
	}
	backend, err := agent.New("codex", agent.Config{ExecutablePath: run.attempt.Runtime.Configuration.ExecutablePath, Env: environment, OnProcessStarted: func(pid int) error { return r.bindProcess(ctx, run, pid) }})
	if err != nil {
		reason = err.Error()
		return
	}
	prompt := fmt.Sprintf("You are the independent Admin investigator for Case %s. First run %q engineering admin status. Read the immutable original observations through the command protocol; use history read for full rows. Preserve original contracts and failure evidence. Do not read or edit private databases or bypass a frozen oracle. Record findings with engineering admin evidence and finish using engineering admin submit --result-file <UTF-8 JSON file in TMPDIR>. Ordinary final text and process exit do not submit a result. Never directly complete business work or close the Case. Use engineering admin workspace-takeover --observation-id <original business observation> --reason <reason> to request scoped takeover; inspect its durable state with status. A source-inspected result only checks provenance. takeoverProgress owned records project resource quiescence; it does not grant repair write authority. Do not modify original worktrees: the host-controlled repair workspace and independent verification commands are not connected yet. Workspace takeover and independent repair verification remain mandatory. After an authorized candidate exists, a verification-requested submission must name the exact takeoverProgress workspace_version, every requiredOriginalObservationId and this attempt's saved repairEvidenceKeys. Proposed verification commands are investigation data only; the host freezes original targets before replying, and confirmed process exit only hands off to waiting verification. No independent Test verdict is connected yet. When these prerequisites are unavailable, submit outcome deferred with summary and nextMethod. Credentials are attempt-scoped and do not grant management control.", run.claim.CaseID, r.Multica)
	session, err := backend.Execute(ctx, prompt, agent.ExecOptions{Cwd: temporary, Model: run.attempt.Runtime.Configuration.Model, ThinkingLevel: run.attempt.Runtime.Configuration.ReasoningEffort})
	if err != nil {
		reason = err.Error()
		return
	}
	messages := session.Messages
	results := session.Result
	for messages != nil || results != nil {
		select {
		case message, ok := <-messages:
			if !ok {
				messages = nil
				continue
			}
			_, _ = fmt.Fprintln(log, strings.ReplaceAll(message.Content, token, "[REDACTED]"))
		case result, ok := <-results:
			if !ok {
				results = nil
				continue
			}
			if result.Error != "" {
				reason = result.Error
			} else {
				reason = "Native Admin process ended; stored terminal receipt remains authoritative"
			}
		}
	}
}
