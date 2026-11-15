package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/engineering/ownership"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type controllerFixture struct {
	task, issue, project, token, credential, controller, claim string
	h                                                          Handler
}

func newControllerFixture(t *testing.T) controllerFixture {
	t.Helper()
	_, token, task, _, issue := engineeringRunFixture(t)
	project := dbfx.Project(t, "Controller ownership")
	dbfx.Exec(t, "UPDATE issue SET project_id=$1 WHERE id=$2", project, issue)
	h := *testHandler
	h.EngineeringWorker = &engineeringRecorder{response: json.RawMessage(`{"allowed":true}`)}
	user, err := h.Queries.GetUser(context.Background(), parseUUID(testUserID))
	if err != nil {
		t.Fatal(err)
	}
	credential, err := h.issueJWT(user)
	if err != nil {
		t.Fatal(err)
	}
	native, err := h.Queries.GetAgentTask(context.Background(), parseUUID(task))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		dbfx.Exec(t, "DELETE FROM engineering_run_process WHERE controller_id IN (SELECT controller_id FROM engineering_run_guard WHERE task_id=$1)", task)
		dbfx.Exec(t, "DELETE FROM engineering_run_guard WHERE task_id=$1", task)
		dbfx.Exec(t, "DELETE FROM engineering_repair_fence WHERE project_id=$1", project)
	})
	return controllerFixture{task: task, issue: issue, project: project, token: token, credential: credential, controller: uuid.NewString(), claim: native.DispatchedAt.Time.Format(time.RFC3339Nano), h: h}
}
func (f controllerFixture) call(t *testing.T, operation string, extras map[string]any, status int) map[string]any {
	t.Helper()
	body := map[string]any{"operation": operation, "controller_id": f.controller, "dispatched_at": f.claim, "host_id": "fixture-boot"}
	for k, v := range extras {
		body[k] = v
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := withURLParam(httptest.NewRequest(http.MethodPost, "/engineering-controller", strings.NewReader(string(raw))), "taskId", f.task)
	req.Header.Set("Authorization", "Bearer "+f.credential)
	handler := middleware.DaemonAuth(f.h.Queries, nil, nil, nil)(http.HandlerFunc(f.h.RecordEngineeringController))
	var out map[string]any
	testutil.Call(t, handler.ServeHTTP, req).Want(status).JSON(&out)
	return out
}
func (f controllerFixture) begin(t *testing.T) {
	f.call(t, "begin", map[string]any{"provider": "codex", "pid": 42, "marker": "fixture-controller"}, 200)
}
func (f controllerFixture) workspace(t *testing.T) {
	f.call(t, "workspace", map[string]any{"workspace_path": t.TempDir(), "mode": "in_place"}, 200)
}
func insertRepairFence(ctx context.Context, tx pgx.Tx, project, issue string) error {
	_, err := tx.Exec(ctx, `INSERT INTO engineering_repair_fence(workspace_id,project_id,case_id,attempt_id,generation,owner_id,supervision_token,intent_revision,observation_id,issue_id,source_attempt_id,source_revision,snapshot_hash,workspace_path)
 VALUES($1,$2,'fixture-case','fixture-attempt',1,'fixture-owner',1,1,'fixture-observation',$3,'fixture-source',1,'fixture-hash','/fixture')`, testWorkspaceID, project, issue)
	return err
}
func (f controllerFixture) fence(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT id FROM project WHERE id=$1 FOR UPDATE", f.project); err != nil {
		t.Fatal(err)
	}
	if err = insertRepairFence(ctx, tx, f.project, f.issue); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dbfx.Exec(t, "DELETE FROM engineering_repair_fence WHERE project_id=$1", f.project) })
}
func TestEngineeringControllerIdentityAndTerminalCleanup(t *testing.T) {
	f := newControllerFixture(t)
	denied := f
	denied.credential = f.token
	denied.call(t, "begin", nil, 401)
	denied = f
	denied.claim = "2000-01-01T00:00:00Z"
	denied.call(t, "begin", nil, 409)
	f.call(t, "begin", map[string]any{"runtime_id": uuid.NewString()}, 400)
	f.begin(t)
	f.begin(t)
	f.call(t, "begin", map[string]any{"provider": "codex", "pid": 43, "marker": "fixture-controller"}, 409)
	f.workspace(t)
	allocation := uuid.NewString()
	f.call(t, "process-reserve", map[string]any{"allocation_id": allocation}, 200)
	f.call(t, "process-reserve", map[string]any{"allocation_id": uuid.NewString()}, 409)
	f.call(t, "process-bind", map[string]any{"allocation_id": allocation, "pid": 71, "group_id": 71, "marker": "fixture-child"}, 200)
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='cancelled' WHERE id=$1", f.task)
	f.call(t, "process-reserve", map[string]any{"allocation_id": uuid.NewString()}, 409)
	f.call(t, "end", map[string]any{"no_provider_started": true}, 409)
	f.call(t, "process-exit", map[string]any{"allocation_id": allocation, "pid": 71, "exit_confirmed": false}, 200)
	if out := f.call(t, "end", map[string]any{"no_provider_started": false}, 200); out["quiesced"] != false {
		t.Fatalf("Unconfirmed allocation released controller: %v", out)
	}
	f.call(t, "process-exit", map[string]any{"allocation_id": allocation, "pid": 72, "exit_confirmed": true}, 409)
	f.call(t, "process-exit", map[string]any{"allocation_id": allocation, "pid": 71, "exit_confirmed": true}, 200)
	if out := f.call(t, "end", map[string]any{"no_provider_started": false}, 200); out["quiesced"] != true {
		t.Fatalf("Physical cleanup was not acknowledged: %v", out)
	}
	f.call(t, "end", map[string]any{"no_provider_started": true}, 409)
	f.call(t, "workspace", map[string]any{"workspace_path": t.TempDir(), "mode": "in_place"}, 409)
}
func TestEngineeringControllerRecordsPIDAfterFenceOrCancel(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(fmt.Sprintf("cancel=%t", cancel), func(t *testing.T) {
			f := newControllerFixture(t)
			f.begin(t)
			f.workspace(t)
			allocation := uuid.NewString()
			f.call(t, "process-reserve", map[string]any{"allocation_id": allocation}, 200)
			if cancel {
				dbfx.Exec(t, "UPDATE agent_task_queue SET status='cancelled' WHERE id=$1", f.task)
			} else {
				f.fence(t)
			}
			f.call(t, "process-bind", map[string]any{"allocation_id": allocation, "pid": 71, "group_id": 71, "marker": "fixture-child"}, 409)
			process, err := f.h.Queries.GetEngineeringRunProcess(context.Background(), db.GetEngineeringRunProcessParams{AllocationID: parseUUID(allocation), ControllerID: parseUUID(f.controller), WorkspaceID: parseUUID(testWorkspaceID)})
			if err != nil || process.Phase != "running" || process.Pid.Int64 != 71 {
				t.Fatalf("Rejected launch lost its actual PID: %+v %v", process, err)
			}
			f.call(t, "process-exit", map[string]any{"allocation_id": allocation, "pid": 71, "exit_confirmed": true}, 200)
			if out := f.call(t, "end", map[string]any{"no_provider_started": false}, 200); out["quiesced"] != true {
				t.Fatalf("Fence prevented physical cleanup receipt: %v", out)
			}
		})
	}
}
func TestEngineeringControllerNoSpawnAndUnsupportedProvider(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			f := newControllerFixture(t)
			f.call(t, "begin", map[string]any{"provider": provider, "pid": 42, "marker": "fixture"}, 200)
			f.workspace(t)
			if out := f.call(t, "end", map[string]any{"no_provider_started": false}, 200); out["quiesced"] != false {
				t.Fatalf("Missing provider facts proved cleanup: %v", out)
			}
			f.call(t, "end", map[string]any{"no_provider_started": true}, 409)
		})
	}
	t.Run("preparation-no-spawn", func(t *testing.T) {
		f := newControllerFixture(t)
		f.begin(t)
		f.fence(t)
		if out := f.call(t, "end", map[string]any{"no_provider_started": true}, 200); out["quiesced"] != true {
			t.Fatalf("Preparation cleanup rejected: %v", out)
		}
	})
}
func TestEngineeringControllerRechecksNativeClaimInsideTransaction(t *testing.T) {
	f := newControllerFixture(t)
	f.begin(t)
	old, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(f.task))
	if err != nil {
		t.Fatal(err)
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET dispatched_at=dispatched_at+interval '1 second' WHERE id=$1", f.task)
	_, err = (ownership.Store{Queries: f.h.Queries, Transactions: f.h.TxStarter}).RecordController(context.Background(), old, parseUUID(testWorkspaceID), ownership.ControllerRequest{ControllerID: parseUUID(f.controller), Operation: "end", HostID: "fixture-boot", NoProviderStarted: func() *bool { v := true; return &v }()})
	if !ownership.IsConflict(err) {
		t.Fatalf("Stale handler snapshot modified a new claim: %v", err)
	}
}
func TestEngineeringRepairFenceSerializesNativeAdmission(t *testing.T) {
	f := newControllerFixture(t)
	native, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(f.task))
	if err != nil {
		t.Fatal(err)
	}
	queued := dbfx.Task(t, uuidToString(native.AgentID), testutil.Cols{"issue_id": f.issue, "runtime_id": uuidToString(native.RuntimeID)})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SELECT id FROM project WHERE id=$1 FOR UPDATE", f.project); err != nil {
		t.Fatal(err)
	}
	if err = insertRepairFence(ctx, tx, f.project, f.issue); err != nil {
		t.Fatal(err)
	}
	conn, err := testPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	result := make(chan error, 1)
	go func() {
		_, err := conn.Exec(ctx, "UPDATE agent_task_queue SET status='dispatched',runtime_id=$1,dispatched_at=now() WHERE id=$2", native.RuntimeID, queued)
		result <- err
	}()
	// Observe the actual database wait; elapsed time alone cannot prove ordering.
	blocked := false
	for !blocked {
		if err = testPool.QueryRow(ctx, "SELECT cardinality(pg_blocking_pids($1))>0", conn.Conn().PgConn().PID()).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if !blocked {
			select {
			case err := <-result:
				t.Fatalf("Admission did not wait for project fence: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-time.After(5 * time.Millisecond):
			}
		}
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-result; !ownership.IsConflict(err) {
		t.Fatalf("Admission missed fence committed during lock wait: %v", err)
	}
	var status string
	dbfx.QueryRow(t, "SELECT status FROM agent_task_queue WHERE id=$1", queued).Scan(&status)
	if status != "queued" {
		t.Fatalf("Fenced queued task dispatched: %s", status)
	}
	// Every fixture row is scoped: another project remains independently usable.
	other := dbfx.Project(t, "Unaffected project")
	issue := dbfx.Issue(t, "Unaffected issue", testutil.Cols{"project_id": other})
	dbfx.Task(t, uuidToString(native.AgentID), testutil.Cols{"issue_id": issue, "runtime_id": uuidToString(native.RuntimeID), "status": "dispatched", "dispatched_at": testutil.Raw("now()")})
}
func TestEngineeringRepairFenceGuardsProjectMutations(t *testing.T) {
	f := newControllerFixture(t)
	f.begin(t)
	resource := dbfx.Insert(t, "project_resource", testutil.Cols{"workspace_id": testWorkspaceID, "project_id": f.project, "resource_type": "local_directory", "resource_ref": testutil.Raw("'{}'::jsonb")})
	chat := dbfx.ChatSession(t, uuidToString(mustControllerTask(t, f).AgentID), testutil.Cols{"project_id": f.project})
	f.fence(t)
	if _, err := testPool.Exec(context.Background(), "UPDATE chat_session SET project_id=NULL WHERE id=$1", chat); !ownership.IsConflict(err) {
		t.Fatalf("Fenced chat changed project: %v", err)
	}
	for _, sql := range []string{"UPDATE project SET title='changed' WHERE id=$1", "DELETE FROM project WHERE id=$1", "UPDATE issue SET project_id=NULL WHERE project_id=$1", "UPDATE project_resource SET resource_ref='{}' WHERE project_id=$1", "DELETE FROM project_resource WHERE project_id=$1"} {
		if _, err := testPool.Exec(context.Background(), sql, f.project); !ownership.IsConflict(err) {
			t.Fatalf("Fence allowed mutation %s: %v", sql, err)
		}
	}
	if resource == "" {
		t.Fatal("Missing native project resource")
	}
	cancelled, err := f.h.TaskService.CancelTaskWithReason(context.Background(), parseUUID(f.task), "Workspace repair is draining the original execution", "intervention")
	if err != nil || cancelled == nil || cancelled.Status != "cancelled" {
		t.Fatalf("Project fence blocked native cancellation: %+v %v", cancelled, err)
	}
	guard, err := f.h.Queries.GetEngineeringRunGuard(context.Background(), db.GetEngineeringRunGuardParams{ControllerID: parseUUID(f.controller), WorkspaceID: parseUUID(testWorkspaceID)})
	if err != nil || guard.Phase != "preparing" {
		t.Fatalf("Native cancellation invented controller cleanup: %+v %v", guard, err)
	}
	f.call(t, "begin", map[string]any{"provider": "codex", "pid": 42, "marker": "fixture"}, 409)
}

func mustControllerTask(t *testing.T, f controllerFixture) db.AgentTaskQueue {
	t.Helper()
	task, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(f.task))
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func TestEngineeringControllerPreventsCompletionUntilLastCleanupReceipt(t *testing.T) {
	f := newControllerFixture(t)
	f.begin(t)
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='failed',completed_at=now() WHERE id=$1", f.task)
	other := dbfx.Issue(t, "Different native issue")
	dbfx.Exec(t, "UPDATE agent_task_queue SET issue_id=$1 WHERE id=$2", other, f.task)
	f.h.EngineeringWorker = &engineeringRecorder{response: json.RawMessage(`{"configured":true,"allowed":true}`)}
	request := func() *http.Request {
		return withURLParam(newRequest(http.MethodPut, "/api/issues/"+f.issue, map[string]any{"status": "done"}), "id", f.issue)
	}
	testutil.Call(t, f.h.UpdateIssue, request()).Want(http.StatusConflict)
	f.call(t, "end", map[string]any{"no_provider_started": true}, 200)
	testutil.Call(t, f.h.UpdateIssue, request()).Want(http.StatusOK)
}
func TestEngineeringControllerIncludesProjectChats(t *testing.T) {
	f := newControllerFixture(t)
	native := mustControllerTask(t, f)
	chat := dbfx.ChatSession(t, uuidToString(native.AgentID), testutil.Cols{"project_id": f.project})
	dbfx.Exec(t, "UPDATE agent_task_queue SET issue_id=NULL,chat_session_id=$1 WHERE id=$2", chat, f.task)
	f.begin(t)
	f.workspace(t)
	guard, err := f.h.Queries.GetEngineeringRunGuard(context.Background(), db.GetEngineeringRunGuardParams{ControllerID: parseUUID(f.controller), WorkspaceID: parseUUID(testWorkspaceID)})
	if err != nil || guard.ProjectID != parseUUID(f.project) {
		t.Fatalf("Project chat escaped ownership: %+v %v", guard, err)
	}
	f.call(t, "end", map[string]any{"no_provider_started": true}, 200)
}

func TestEngineeringControllerRetainsOriginalIssueAcrossReplacementClaims(t *testing.T) {
	f := newControllerFixture(t)
	f.begin(t)
	native := mustControllerTask(t, f)
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='failed',completed_at=now() WHERE id=$1", f.task)
	replacement := dbfx.Task(t, uuidToString(native.AgentID), testutil.Cols{"issue_id": f.issue, "runtime_id": uuidToString(native.RuntimeID), "status": "running", "dispatched_at": testutil.Raw("now()")})
	next := f
	next.task = replacement
	next.controller = uuid.NewString()
	next.claim = mustControllerTask(t, next).DispatchedAt.Time.Format(time.RFC3339Nano)
	t.Cleanup(func() { dbfx.Exec(t, "DELETE FROM engineering_run_guard WHERE task_id=$1", replacement) })
	next.call(t, "begin", map[string]any{"provider": "codex", "pid": 42, "marker": "fixture-controller"}, 409)
	f.call(t, "end", map[string]any{"no_provider_started": true}, 200)
	next.begin(t)
	next.call(t, "end", map[string]any{"no_provider_started": true}, 200)
}

func TestEngineeringControllerSurrenderStillRecordsLatePhysicalIdentity(t *testing.T) {
	f := newControllerFixture(t)
	f.begin(t)
	f.workspace(t)
	allocation := uuid.NewString()
	f.call(t, "process-reserve", map[string]any{"allocation_id": allocation}, 200)
	f.h.EngineeringWorker = &engineeringRecorder{response: json.RawMessage(`{"allowed":false}`)}
	f.call(t, "process-bind", map[string]any{"allocation_id": allocation, "pid": 71, "group_id": 71, "marker": "fixture"}, 409)
	process, err := f.h.Queries.GetEngineeringRunProcess(context.Background(), db.GetEngineeringRunProcessParams{ControllerID: parseUUID(f.controller), AllocationID: parseUUID(allocation), WorkspaceID: parseUUID(testWorkspaceID)})
	if err != nil || process.Pid.Int64 != 71 {
		t.Fatalf("Surrender lost late physical identity: %+v %v", process, err)
	}
	f.call(t, "process-reserve", map[string]any{"allocation_id": uuid.NewString()}, 409)
	f.call(t, "process-exit", map[string]any{"allocation_id": allocation, "pid": 71, "exit_confirmed": true}, 200)
	f.call(t, "end", map[string]any{"no_provider_started": false}, 200)
}

func TestEngineeringControllerClaimFlagIncludesNativeIssuesAndChats(t *testing.T) {
	for _, name := range []string{"local-issue", "local-chat", "cloud", "no-project", "disabled"} {
		t.Run(name, func(t *testing.T) {
			f := newControllerFixture(t)
			task := mustControllerTask(t, f)
			runtime, err := f.h.Queries.GetAgentRuntime(context.Background(), task.RuntimeID)
			if err != nil {
				t.Fatal(err)
			}
			runtime.RuntimeMode = "local"
			f.h.EngineeringWorker = &engineeringRecorder{response: json.RawMessage(`{"configured":false}`)}
			switch name {
			case "local-chat":
				chat := dbfx.ChatSession(t, uuidToString(task.AgentID), testutil.Cols{"project_id": f.project})
				dbfx.Exec(t, "UPDATE agent_task_queue SET issue_id=NULL,chat_session_id=$1 WHERE id=$2", chat, f.task)
				task = mustControllerTask(t, f)
			case "cloud":
				runtime.RuntimeMode = "cloud"
			case "no-project":
				dbfx.Exec(t, "UPDATE issue SET project_id=NULL WHERE id=$1", f.issue)
			case "disabled":
				f.h.EngineeringWorker = nil
			}
			response, _, _, _, _, failure := f.h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &task, runtime, uuidToString(task.RuntimeID), testWorkspaceID)
			want := name == "local-issue" || name == "local-chat"
			if failure != nil || response.EngineeringOwnership != want {
				t.Fatalf("Claim ownership flag=%t want %t, failure=%+v", response.EngineeringOwnership, want, failure)
			}
		})
	}
}
