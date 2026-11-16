package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"os"
)

type historyPreparationFixture struct {
	h                             Handler
	fx                            *testutil.Fixture
	roles                         map[string]string
	namespace, team, projectTitle string
	teamRevision                  int
	workflow, kind                string
	deleted, terminal, incomplete bool
}

func newHistoryPreparationFixture(t *testing.T, pool *pgxpool.Pool) *historyPreparationFixture {
	t.Helper()
	ctx := context.Background()
	h := *testHandler
	h.Queries = db.New(pool)
	h.DB = pool
	h.TxStarter = pool
	h.cfg.LocalAuthEnabled = true
	h.cfg.EngineeringHistoryHash = strings.Repeat("a", 64)
	if _, err := h.ensureLocalIdentity(ctx); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(uuid.NewString()))
	f := &historyPreparationFixture{h: h, namespace: hex.EncodeToString(sum[:]), teamRevision: 1, workflow: "develop", kind: "feature"}
	f.projectTitle = "History preparation fixture " + f.namespace
	f.fx = testutil.New(pool, localWorkspaceID, localUserID)
	f.roles = map[string]string{}
	for _, role := range engineeringTeamRoles["develop"] {
		f.roles[role] = f.fx.Agent(t, "Preparation "+role, "", testutil.Cols{"runtime_mode": "local"})
	}
	f.team = f.fx.Squad(t, "Prepared Team", f.roles["context"])
	for _, id := range f.roles {
		f.fx.SquadMember(t, f.team, "agent", id)
	}
	t.Cleanup(func() {
		f.fx.Exec(t, "DELETE FROM engineering_history_preparation WHERE source_namespace=$1", f.namespace)
		f.fx.Exec(t, "DELETE FROM project WHERE workspace_id=$1 AND title=$2", localWorkspaceID, f.projectTitle)
		f.fx.Exec(t, "DELETE FROM engineering_history_project WHERE source_namespace=$1", f.namespace)
	})
	f.h.EngineeringHistoryWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["action"] != "preparation-source" || input["expected_hash"] != f.h.cfg.EngineeringHistoryHash {
			t.Error("unscoped preparation source request")
		}
		sections := []map[string]any{{"table": "tasks", "rows": []map[string]any{{"task_id": input["task_id"], "item_type": f.kind}}}}
		for _, name := range strings.Fields("projects acceptances stories story_specs delivery_unit_acceptances delivery_unit_dependencies delivery_unit_context_links task_dependencies requirement_metadata agent_work_drafts command_chain_drafts command_chain_artifact_blocks command_chain_decisions command_chain_acceptance_items command_chain_runtime_inputs business_analysis_drafts business_analysis_module_items business_analysis_phase_artifacts questions runtime_input_requests documents document_comments feedback_batches feedback_groups feedback_batch_comments feedback_group_comments feedback_group_delivery_units task_context_chat_sessions task_context_chat_messages task_context_chat_change_requests") {
			sections = append(sections, map[string]any{"table": name, "rows": []any{}})
		}
		var deleted *string
		if f.deleted {
			value := "2026-09-09"
			deleted = &value
		}
		return json.Marshal(map[string]any{"historical_only": true, "namespace": f.namespace, "source": map[string]string{"hash": f.h.cfg.EngineeringHistoryHash}, "packet": map[string]any{"format": "loopwork-task-handoff-v1", "hash": strings.Repeat("b", 64), "source": map[string]string{"hash": f.h.cfg.EngineeringHistoryHash}, "source_task_id": input["task_id"], "source_project": map[string]any{"id": "original-project", "name": f.projectTitle, "deleted_at": deleted}, "source_task_terminal": f.terminal, "schema_complete": !f.incomplete, "ownership": map[string]any{"source_owner": "LoopWork", "native_execution_authorized": false}, "sections": sections}})
	}}
	f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["action"] != "team-lookup" {
			t.Error("preparation attempted to configure or start a Team")
		}
		payload := input["payload"].(map[string]string)
		if payload["team_id"] != f.team {
			return json.RawMessage(`{"profile":null}`), nil
		}
		return json.Marshal(map[string]any{"profile": map[string]any{"workspaceId": localWorkspaceID, "teamId": f.team, "revision": f.teamRevision, "definition": map[string]any{"workflow": f.workflow, "roles": f.roles, "decision_mode": "balanced", "max_reworks": 2}}})
	}}
	return f
}
func (f *historyPreparationFixture) request(method, task string, body any) *http.Request {
	r := withURLParam(newRequest(method, "/api/engineering/history/tasks/"+task+"/preparation", body), "sourceTaskID", task)
	r.Header.Set("X-User-ID", localUserID)
	r.Header.Set("X-Workspace-ID", localWorkspaceID)
	return r
}
func (f *historyPreparationFixture) input() map[string]any {
	return map[string]any{"expected_revision": 0, "expected_packet_hash": strings.Repeat("b", 64), "team_id": f.team, "expected_team_revision": f.teamRevision, "create_project": true}
}
func (f *historyPreparationFixture) count(t *testing.T, table string) int {
	return f.fx.Count(t, "SELECT count(*) FROM "+table+" WHERE source_namespace=$1", f.namespace)
}

func TestEngineeringHistoryPreparationPersistsVersionsAndReplaysWithoutNativeExecution(t *testing.T) {
	pool := testutil.IsolatedDB(t, os.Getenv("DATABASE_URL"))
	f := newHistoryPreparationFixture(t, pool)
	beforeIssues := f.fx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", localWorkspaceID)
	beforeRuns := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue t JOIN agent a ON a.id=t.agent_id WHERE a.workspace_id=$1", localWorkspaceID)
	input := f.input()
	var first, replay map[string]any
	testutil.Call(t, f.h.PrepareEngineeringHistoryTask, f.request(http.MethodPost, "original-1", input)).Want(http.StatusOK).JSON(&first)
	testutil.Call(t, f.h.PrepareEngineeringHistoryTask, f.request(http.MethodPost, "original-1", input)).Want(http.StatusOK).JSON(&replay)
	if first["id"] != replay["id"] || first["revision"] != float64(1) || first["execution_authorized"] != false || f.count(t, "engineering_history_preparation") != 1 || f.count(t, "engineering_history_project") != 1 {
		t.Fatal("duplicate or executable preparation", first, replay)
	}
	future := f.input()
	future["expected_revision"] = 5
	testutil.Call(t, f.h.PrepareEngineeringHistoryTask, f.request(http.MethodPost, "original-1", future)).Want(http.StatusConflict)
	var sibling map[string]any
	testutil.Call(t, f.h.PrepareEngineeringHistoryTask, f.request(http.MethodPost, "original-2", input)).Want(http.StatusOK).JSON(&sibling)
	if sibling["project_id"] != first["project_id"] {
		t.Fatal("siblings created separate native projects")
	}
	f.teamRevision = 2
	next := f.input()
	next["expected_revision"] = 1
	var updated map[string]any
	testutil.Call(t, f.h.PrepareEngineeringHistoryTask, f.request(http.MethodPost, "original-1", next)).Want(http.StatusOK).JSON(&updated)
	if updated["revision"] != float64(2) || f.count(t, "engineering_history_preparation") != 3 {
		t.Fatal("preparation history was overwritten")
	}
	var state struct {
		SourceOwner         string `json:"source_owner"`
		ExecutionAuthorized bool   `json:"execution_authorized"`
		Preparations        []struct {
			Current bool `json:"current"`
		} `json:"preparations"`
	}
	testutil.Call(t, f.h.GetEngineeringHistoryPreparation, f.request(http.MethodGet, "original-1", nil)).Want(http.StatusOK).JSON(&state)
	if state.SourceOwner != "LoopWork" || state.ExecutionAuthorized || len(state.Preparations) != 2 || !state.Preparations[0].Current || state.Preparations[1].Current {
		t.Fatal("prepared version became an execution handoff", state)
	}
	rows, err := f.h.Queries.ListEngineeringHistoryPreparations(context.Background(), db.ListEngineeringHistoryPreparationsParams{WorkspaceID: parseUUID(localWorkspaceID), SourceNamespace: f.namespace, SourceTaskID: "original-1"})
	if err != nil {
		t.Fatal(err)
	}
	var saved struct {
		TeamProfile         engineeringTeamSnapshot    `json:"team_profile"`
		ExecutionAuthorized bool                       `json:"execution_authorized"`
		Packet              engineeringHistoryMaterial `json:"packet"`
	}
	if json.Unmarshal(rows[1].Payload, &saved) != nil || saved.TeamProfile.Revision != 1 || saved.ExecutionAuthorized || saved.Packet.Hash != strings.Repeat("b", 64) {
		t.Fatal("original source or Team snapshot changed")
	}
	if f.fx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", localWorkspaceID) != beforeIssues || f.fx.Count(t, "SELECT count(*) FROM agent_task_queue t JOIN agent a ON a.id=t.agent_id WHERE a.workspace_id=$1", localWorkspaceID) != beforeRuns {
		t.Fatal("preparation created native execution")
	}
	testutil.Call(t, f.h.PrepareEngineeringHistoryTask, f.request(http.MethodPost, "original-1", input)).Want(http.StatusConflict)
}

func TestEngineeringHistoryPreparationConcurrentSiblingsShareOneProject(t *testing.T) {
	pool := testutil.IsolatedDB(t, os.Getenv("DATABASE_URL"))
	f := newHistoryPreparationFixture(t, pool)
	var wait sync.WaitGroup
	statuses := make(chan int, 4)
	for _, task := range []string{"one", "two", "one", "two"} {
		wait.Add(1)
		go func(id string) {
			defer wait.Done()
			w := httptest.NewRecorder()
			f.h.PrepareEngineeringHistoryTask(w, f.request(http.MethodPost, id, f.input()))
			statuses <- w.Code
		}(task)
	}
	wait.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusOK {
			t.Fatal("concurrent preparation failed", status)
		}
	}
	if f.count(t, "engineering_history_project") != 1 || f.count(t, "engineering_history_preparation") != 2 || f.fx.Count(t, "SELECT count(*) FROM project WHERE title=$1", f.projectTitle) != 1 {
		t.Fatal("concurrent or retried preparation duplicated the source project")
	}
}

func TestEngineeringHistoryPreparationRejectsStaleScopeAndRollsBackProject(t *testing.T) {
	pool := testutil.IsolatedDB(t, os.Getenv("DATABASE_URL"))
	for _, mode := range []string{"deleted", "terminal", "incomplete", "unsupported", "hash", "revision", "team-revision", "wrong-workflow", "archived-team", "foreign-project", "invalid-team", "no-project", "machine", "cloud", "foreign-user", "foreign-workspace"} {
		t.Run(mode, func(t *testing.T) {
			f := newHistoryPreparationFixture(t, pool)
			body := f.input()
			want := http.StatusConflict
			switch mode {
			case "deleted":
				f.deleted = true
			case "terminal":
				f.terminal = true
			case "incomplete":
				f.incomplete = true
			case "unsupported":
				f.kind = "openspec"
			case "hash":
				body["expected_packet_hash"] = strings.Repeat("c", 64)
			case "revision":
				body["expected_revision"] = 1
			case "team-revision":
				body["expected_team_revision"] = 2
			case "wrong-workflow":
				f.workflow = "direct"
			case "archived-team":
				f.fx.Exec(t, "UPDATE squad SET archived_at=now() WHERE id=$1", f.team)
			case "foreign-project":
				body["create_project"] = false
				body["project_id"] = uuid.NewString()
			case "invalid-team":
				body["team_id"] = "not-a-uuid"
				want = http.StatusBadRequest
			case "no-project":
				body["create_project"] = false
				want = http.StatusBadRequest
			}
			r := f.request(http.MethodPost, "original", body)
			switch mode {
			case "machine":
				r.Header.Set("X-Actor-Source", "task_token")
				want = http.StatusForbidden
			case "cloud":
				r.Header.Set("X-Actor-Source", "cloud_pat")
				want = http.StatusForbidden
			case "foreign-user":
				r.Header.Set("X-User-ID", testUserID)
				want = http.StatusForbidden
			case "foreign-workspace":
				r.Header.Set("X-Workspace-ID", testWorkspaceID)
				want = http.StatusForbidden
			}
			testutil.Call(t, f.h.PrepareEngineeringHistoryTask, r).Want(want)
			if f.count(t, "engineering_history_preparation") != 0 || f.count(t, "engineering_history_project") != 0 || f.fx.Count(t, "SELECT count(*) FROM project WHERE title=$1", f.projectTitle) != 0 {
				t.Fatal("rejected preparation left native metadata behind")
			}
		})
	}
}

func TestEngineeringHistoryPreparationMissingMappedProjectDoesNotRecreateIt(t *testing.T) {
	pool := testutil.IsolatedDB(t, os.Getenv("DATABASE_URL"))
	f := newHistoryPreparationFixture(t, pool)
	var saved map[string]any
	testutil.Call(t, f.h.PrepareEngineeringHistoryTask, f.request(http.MethodPost, "original", f.input())).Want(http.StatusOK).JSON(&saved)
	f.fx.Exec(t, "DELETE FROM project WHERE id=$1", saved["project_id"])
	testutil.Call(t, f.h.PrepareEngineeringHistoryTask, f.request(http.MethodPost, "original", f.input())).Want(http.StatusConflict)
	var state struct {
		Blockers []string `json:"blockers"`
	}
	testutil.Call(t, f.h.GetEngineeringHistoryPreparation, f.request(http.MethodGet, "original", nil)).Want(http.StatusOK).JSON(&state)
	if !strings.Contains(strings.Join(state.Blockers, ","), "mapped_project_unavailable") || f.count(t, "engineering_history_project") != 1 {
		t.Fatal("missing correspondence silently redirected", state)
	}
}
