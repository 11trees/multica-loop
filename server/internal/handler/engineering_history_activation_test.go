package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/testutil"
)

type historyActivationFixture struct {
	*historyAdoptionFixture
	workspaceHash, project, runtime, daemon, root string
	dirty, drift                                  bool
}

func newHistoryActivationFixture(t *testing.T) *historyActivationFixture {
	t.Helper()
	f := &historyActivationFixture{historyAdoptionFixture: newHistoryAdoptionFixture(t), workspaceHash: strings.Repeat("e", 64), dirty: true, daemon: uuid.NewString()}
	f.root = t.TempDir()
	var staged struct {
		Tasks []struct {
			IssueID string `json:"issue_id"`
		}
	}
	testutil.Call(t, f.h.StageEngineeringHistoryCutover, f.stageRequest(f.body())).Want(200).JSON(&staged)
	for _, task := range staged.Tasks {
		f.fx.Cleanup(t, "DELETE FROM issue WHERE id=$1", task.IssueID)
	}
	f.fx.QueryRow(t, "SELECT project_ids[1]::text FROM engineering_history_cutover WHERE id=$1", f.id).Scan(&f.project)
	f.fx.Exec(t, "UPDATE engineering_history_cutover SET receipt=$2 WHERE id=$1", f.id, historyAdoptionJSON(t, map[string]any{"workspace_observations": []any{map[string]any{"hash": f.workspaceHash, "payload": map[string]any{"fixture": true}}}}))
	directory := t.TempDir()
	t.Setenv(cli.TaskConfigRootEnv, directory)
	if err := os.WriteFile(filepath.Join(directory, "daemon.id"), []byte(f.daemon), 0600); err != nil {
		t.Fatal(err)
	}
	f.runtime = f.fx.Runtime(t, "Explicit fake migration runtime", testutil.Cols{"daemon_id": f.daemon, "runtime_mode": "local"})
	for _, agent := range f.roles {
		f.fx.Exec(t, "UPDATE agent SET runtime_id=$1 WHERE id=$2", f.runtime, agent)
		f.fx.Cleanup(t, "UPDATE agent SET runtime_id=NULL WHERE id=$1", agent)
	}
	original := f.h.EngineeringSourceInspector
	f.h.EngineeringSourceInspector = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["action"] != "workspace-check" {
			return original.Call(context.Background(), input)
		}
		if input["expected_workspace_hash"] != f.workspaceHash {
			t.Error("unscoped workspace inspection")
		}
		return json.Marshal(map[string]any{"format": "loopwork-activation-source-inspection-v1", "cutover_id": f.id, "archive_hash": f.h.cfg.EngineeringHistoryHash, "scope_hash": f.scope, "source_namespace": f.namespace, "workspace_hash": f.workspaceHash, "matches_saved_baseline": !f.drift, "source_frozen": true, "registered_writers_quiesced": !f.blocked, "physical_quiescence_confirmed": false, "execution_authorized": false, "workspaces": []any{map[string]any{"project_id": f.project, "root": f.root, "head": strings.Repeat("a", 40), "dirty": f.dirty, "symlinks": 0}}})
	}}
	t.Cleanup(func() { f.fx.Exec(t, "DELETE FROM project_resource WHERE project_id=$1", f.project) })
	return f
}
func (f *historyActivationFixture) activationBody(mode string) map[string]any {
	return map[string]any{"expected_scope_hash": f.scope, "expected_workspace_hash": f.workspaceHash, "execution_mode": mode}
}
func (f *historyActivationFixture) assertHeld(t *testing.T) {
	t.Helper()
	if f.fx.Count(t, "SELECT count(*) FROM engineering_history_cutover WHERE id=$1 AND phase='source_frozen' AND activation IS NULL", f.id) != 1 || f.fx.Count(t, "SELECT count(*) FROM project_resource WHERE project_id=$1", f.project) != 0 || f.fx.Count(t, "SELECT count(*) FROM engineering_history_adoption WHERE cutover_id=$1 AND phase='staged'", f.id) != 2 {
		t.Fatal("failed activation partially released the cohort")
	}
}
func TestEngineeringHistoryActivationCommitsResourcesAndOwnershipWithoutStartingTasks(t *testing.T) {
	f := newHistoryActivationFixture(t)
	var first, replay historyActivationReceipt
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("in_place"))).Want(200).JSON(&first)
	for _, task := range first.Tasks {
		var description string
		f.fx.QueryRow(t, "SELECT description FROM issue WHERE id=$1", task["issue_id"]).Scan(&description)
		if !strings.HasPrefix(description, historyActivatedNotice) || !strings.Contains(description, "Original obligations") {
			t.Fatal("activation notice lost original goal or stayed pending")
		}
	}
	if first.ExecutionStarted || len(first.Tasks) != 2 || len(first.Resources) != 1 || len(first.Roles) != 6 {
		t.Fatal("activation changed task execution or omitted resources", first)
	}
	if f.fx.Count(t, "SELECT count(*) FROM engineering_history_adoption WHERE cutover_id=$1 AND phase='activated'", f.id) != 2 || f.fx.Count(t, "SELECT count(*) FROM issue WHERE project_id=$1 AND status='backlog'", f.project) != 2 {
		t.Fatal("activation did not retain both Backlog Team tasks")
	}
	if f.fx.Count(t, "SELECT count(*) FROM project_resource WHERE project_id=$1 AND id=$2", f.project, first.Resources[0].ID) != 1 || f.fx.Count(t, "SELECT count(*) FROM agent_task_queue t JOIN issue i ON i.id=t.issue_id WHERE i.project_id=$1", f.project) != 0 {
		t.Fatal("activation created a run or lost its frozen resource")
	}
	if f.fx.Count(t, "SELECT count(*) FROM project WHERE id=$1 AND engineering_history_project_held(id)", f.project) != 0 {
		t.Fatal("activated project stayed held")
	}
	// Lost acknowledgement is replayed from the receipt, even after mutable
	// source/Team facts change. It cannot recreate resources or enqueue work.
	f.blocked = true
	f.drift = true
	f.teamRevision = 2
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("in_place"))).Want(200).JSON(&replay)
	if !historyJSONEqual(historyAdoptionJSON(t, first), historyAdoptionJSON(t, replay)) {
		t.Fatal("activation retry changed immutable receipt")
	}
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("worktree"))).Want(409)
	testutil.Call(t, f.h.WithdrawEngineeringHistoryCutover, f.stageRequest(f.body())).Want(409)
	if _, err := testPool.Exec(context.Background(), "UPDATE engineering_history_cutover SET phase='rollback_pending' WHERE id=$1", f.id); err == nil {
		t.Fatal("activated ownership used pre-activation rollback")
	}
	if _, err := testPool.Exec(context.Background(), "UPDATE engineering_history_cutover SET activation='{}' WHERE id=$1", f.id); err == nil {
		t.Fatal("activation receipt was replaced")
	}
	down, readErr := os.ReadFile("../../migrations/682_engineering_history_activation.down.sql")
	if readErr != nil {
		t.Fatal(readErr)
	}
	if _, err := testPool.Exec(context.Background(), string(down)); err == nil || !strings.Contains(err.Error(), "retain activated migration") {
		t.Fatal("migration down discarded activated ownership", err)
	}
}
func TestEngineeringHistoryActivationRejectsDriftAndUnboundRuntimeWithoutPartialWrites(t *testing.T) {
	f := newHistoryActivationFixture(t)
	bad := f.activationBody("in_place")
	bad["runtime_id"] = f.runtime
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(bad)).Want(400)
	machine := f.stageRequest(f.activationBody("in_place"))
	machine.Header.Set("X-Actor-Type", "agent")
	machine.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, machine).Want(403)
	f.drift = true
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("in_place"))).Want(409)
	f.assertHeld(t)
	f.drift = false
	f.blocked = true
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("in_place"))).Want(409)
	f.assertHeld(t)
	f.blocked = false
	f.teamRevision = 2
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("in_place"))).Want(409)
	f.assertHeld(t)
	f.teamRevision = 1
	f.fx.Exec(t, "UPDATE agent SET runtime_id=NULL WHERE id=$1", f.roles["developer"])
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("in_place"))).Want(409)
	f.assertHeld(t)
	f.fx.Exec(t, "UPDATE agent SET runtime_id=$1 WHERE id=$2", f.runtime, f.roles["developer"])
	f.fx.Exec(t, "UPDATE agent_runtime SET daemon_id=$1 WHERE id=$2", uuid.NewString(), f.runtime)
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("in_place"))).Want(409)
	f.assertHeld(t)
	f.fx.Exec(t, "UPDATE agent_runtime SET daemon_id=$1 WHERE id=$2", f.daemon, f.runtime)
	f.fx.Exec(t, "UPDATE issue SET title='New human goal' WHERE id=(SELECT issue_id FROM engineering_history_adoption WHERE cutover_id=$1 LIMIT 1)", f.id)
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("in_place"))).Want(409)
	f.assertHeld(t)
}
func TestEngineeringHistoryActivationWorktreeRequiresCleanContentAndCapability(t *testing.T) {
	f := newHistoryActivationFixture(t)
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("worktree"))).Want(409)
	f.assertHeld(t)
	f.dirty = false
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("worktree"))).Want(409)
	f.assertHeld(t)
	f.fx.Exec(t, `UPDATE agent_runtime SET metadata='{"capabilities":["local-worktree-v1"]}' WHERE id=$1`, f.runtime)
	var activated historyActivationReceipt
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("worktree"))).Want(200).JSON(&activated)
	if activated.ExecutionMode != "worktree" || activated.ExecutionStarted {
		t.Fatal("worktree activation started tasks or changed mode")
	}
}
func TestEngineeringHistoryActivationConcurrentRetriesReuseOneReceipt(t *testing.T) {
	f := newHistoryActivationFixture(t)
	var group sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			w := httptest.NewRecorder()
			f.h.ActivateEngineeringHistoryCutover(w, f.stageRequest(f.activationBody("in_place")))
			results <- w
		}()
	}
	group.Wait()
	close(results)
	var body []byte
	for result := range results {
		if result.Code != http.StatusOK {
			t.Fatal("concurrent activation failed", result.Code, result.Body.String())
		}
		if body != nil && !historyJSONEqual(body, result.Body.Bytes()) {
			t.Fatal("concurrent activation changed receipt")
		}
		body = result.Body.Bytes()
	}
	if f.fx.Count(t, "SELECT count(*) FROM project_resource WHERE project_id=$1", f.project) != 1 {
		t.Fatal("concurrent activation duplicated project resources")
	}
}

type historyActivationFailStarter struct{ base txStarter }

func (s historyActivationFailStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.base.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return historyActivationFailTx{Tx: tx}, nil
}

type historyActivationFailTx struct{ pgx.Tx }

func (tx historyActivationFailTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if strings.Contains(sql, "-- name: CreateEngineeringHistoryResource") {
		return pgconn.CommandTag{}, errors.New("fixture resource persistence failure")
	}
	return tx.Tx.Exec(ctx, sql, args...)
}
func TestEngineeringHistoryActivationRollsBackOwnershipWhenResourcePersistenceFails(t *testing.T) {
	f := newHistoryActivationFixture(t)
	f.h.TxStarter = historyActivationFailStarter{base: f.h.TxStarter}
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("in_place"))).Want(503)
	f.assertHeld(t)
}
func TestEngineeringHistoryActivationRetainsPreparedTeamAtLaterTaskStart(t *testing.T) {
	f := newHistoryActivationFixture(t)
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("in_place"))).Want(200)
	var issueID string
	f.fx.QueryRow(t, "SELECT issue_id::text FROM engineering_history_adoption WHERE cutover_id=$1 LIMIT 1", f.id).Scan(&issueID)
	f.fx.Exec(t, "UPDATE issue SET status='todo' WHERE id=$1", issueID)
	f.teamRevision = 2
	original := f.h.EngineeringWorker
	f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["action"] == "team-routing" {
			return original.Call(context.Background(), map[string]any{"action": "team-lookup", "payload": map[string]string{"team_id": f.team}})
		}
		return original.Call(context.Background(), input)
	}}
	issue, err := f.h.Queries.GetIssue(context.Background(), parseUUID(issueID))
	if err != nil {
		t.Fatal(err)
	}
	if err = f.h.startEngineeringTeamIssue(context.Background(), issue, localUserID); err == nil || !strings.Contains(err.Error(), "retains its prepared Team") {
		t.Fatal("changed Team bypassed prepared activation", err)
	}
}

func TestEngineeringHistoryActivationAllowsOrdinaryTeamStartAfterAcceptance(t *testing.T) {
	f := newHistoryActivationFixture(t)
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("in_place"))).Want(200)
	var issueID string
	f.fx.QueryRow(t, "SELECT issue_id::text FROM engineering_history_adoption WHERE cutover_id=$1 LIMIT 1", f.id).Scan(&issueID)
	starts := 0
	original := f.h.EngineeringWorker
	f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		switch input["action"] {
		case "team-routing":
			return original.Call(context.Background(), map[string]any{"action": "team-lookup", "payload": map[string]string{"team_id": f.team}})
		case "team-start":
			payload := input["payload"].(map[string]any)
			if payload["team_id"] != f.team || payload["project_id"] != f.project || payload["team_revision"] != 1 {
				t.Error("ordinary Start lost the prepared Team/project")
			}
			starts++
			return json.RawMessage(`{}`), nil
		case "continuations":
			return json.RawMessage(`[]`), nil
		}
		return original.Call(context.Background(), input)
	}}
	request := func() *http.Request {
		r := withURLParam(newRequest(http.MethodPost, "/engineering/team-start", map[string]any{}), "id", issueID)
		r.Header.Set("X-User-ID", localUserID)
		r.Header.Set("X-Workspace-ID", localWorkspaceID)
		return r
	}
	testutil.Call(t, f.h.StartEngineeringTeam, request()).Want(409)
	if starts != 0 {
		t.Fatal("activation started an unaccepted task")
	}
	f.fx.Exec(t, "UPDATE issue SET status='todo' WHERE id=$1", issueID)
	testutil.Call(t, f.h.StartEngineeringTeam, request()).Want(200)
	if starts != 1 {
		t.Fatal("accepted activated task could not use its ordinary Team Start")
	}
}
