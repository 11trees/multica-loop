package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type recoveryWatchFixture struct {
	takeoverControlFixture
	task        db.AgentTaskQueue
	published   engineeringHandoffPublished
	application engineeringHandoffApplication
	management  map[string]any
}

func newRecoveryWatchFixture(t *testing.T) recoveryWatchFixture {
	t.Helper()
	ctx := context.Background()
	f := newTakeoverControlFixture(t)
	original := mustControllerTask(t, f.controllerFixture)
	dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='quiesced',no_provider_started=true WHERE task_id=$1", f.task)
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='cancelled',completed_at=now() WHERE id=$1", f.task)
	dbfx.Exec(t, "UPDATE agent_runtime SET status='online',last_seen_at=now(),max_concurrent_tasks=NULL WHERE id=$1", original.RuntimeID)
	dbfx.Exec(t, "UPDATE agent SET max_concurrent_tasks=5 WHERE id=$1", original.AgentID)
	id := dbfx.Task(t, uuidToString(original.AgentID), testutil.Cols{"issue_id": f.issue, "runtime_id": original.RuntimeID, "originator_user_id": testUserID, "accountable_user_id": testUserID, "status": "queued", "priority": 50})
	task, err := f.h.Queries.GetAgentTask(ctx, parseUUID(id))
	if err != nil {
		t.Fatal(err)
	}
	item := engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: f.issue, AgentID: uuidToString(task.AgentID), UserID: testUserID, TaskID: id, ExpectedRevision: 1, ExpectedSequence: 5, Reason: "repair_ready"}
	target := strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")
	r := engineeringHandoffReservation{Reserved: true, CaseID: "fixture-case", VerificationAttemptID: "watch-verification", TargetHash: target, PreparationHash: strings.Repeat("d", 64), ProjectID: f.project, ExpectedVersion: "workspace-content-v1:" + strings.Repeat("a", 40) + ":" + strings.Repeat("b", 64), Continuation: item}
	r.Hash = engineeringHandoffReservationHash(r)
	payload, _ := json.Marshal(r)
	if _, err = f.h.Queries.CreateEngineeringRepairHandoffReservation(ctx, db.CreateEngineeringRepairHandoffReservationParams{TargetHash: target, WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project), TaskID: task.ID, Payload: string(payload)}); err != nil {
		t.Fatal(err)
	}
	dbfx.Exec(t, "UPDATE engineering_repair_handoff SET phase='published' WHERE target_hash=$1", target)
	draft := uuid.NewString()
	a := engineeringHandoffApplication{Staged: true, HoldRetained: true, Hash: strings.Repeat("e", 64), TargetHash: target, PreparationHash: r.PreparationHash, ReservationHash: r.Hash, ExpectedVersion: r.ExpectedVersion, Continuation: item, DraftID: &draft}
	ready := engineeringHandoffReady{Ready: true, TargetHash: target, ReservationHash: r.Hash, ApplicationHash: a.Hash, ExpectedVersion: r.ExpectedVersion, Continuation: item}
	ready.Hash = engineeringHandoffReadyHash(ready)
	p := engineeringHandoffPublication{Published: true, CaseID: r.CaseID, VerificationAttemptID: r.VerificationAttemptID, TargetHash: target, ReservationHash: r.Hash, ApplicationHash: a.Hash, ReadyHash: ready.Hash, TaskID: id, WorkspaceID: testWorkspaceID, IssueID: f.issue, AgentID: item.AgentID, UserID: testUserID, RuntimeID: uuidToString(task.RuntimeID)}
	p.Hash = engineeringHandoffPublicationHash(p)
	published := engineeringHandoffPublished{Ready: ready, Publication: p}
	payload, _ = json.Marshal(published)
	if _, err = f.h.Queries.CreateEngineeringRepairPublication(ctx, db.CreateEngineeringRepairPublicationParams{TargetHash: target, WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project), TaskID: task.ID, Payload: string(payload)}); err != nil {
		t.Fatal(err)
	}
	current := map[string]any{}
	for k, v := range f.current {
		current[k] = v
	}
	current["current_intent_revision"] = 1
	current["target_hash"] = target
	current["reservation"] = r
	current["application"] = a
	current["publication"] = published
	return recoveryWatchFixture{f, task, published, a, current}
}

func TestEngineeringRecoveryReadiness(t *testing.T) {
	for _, mode := range []string{"runnable", "capacity-unknown", "capacity-full", "running", "resource-wait", "human-wait", "paused", "business-unavailable", "unknown-controller", "scope-changed", "stopped"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f := newRecoveryWatchFixture(t)
			runtime, err := f.h.Queries.GetAgentRuntime(ctx, f.task.RuntimeID)
			if err != nil {
				t.Fatal(err)
			}
			if mode != "capacity-unknown" {
				slots := 1
				if mode == "capacity-full" {
					slots = 0
				}
				f.h.TaskService.EngineeringCapacity.Observe([]db.AgentRuntime{runtime}, slots, time.Now())
			}
			if mode == "running" {
				dbfx.Exec(t, "UPDATE agent_task_queue SET status='running',dispatched_at=now() WHERE id=$1", f.task.ID)
			}
			if mode == "resource-wait" {
				dbfx.Exec(t, "UPDATE agent_task_queue SET status='waiting_local_directory',dispatched_at=now() WHERE id=$1", f.task.ID)
			}
			if mode == "unknown-controller" {
				dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='preparing',no_provider_started=false WHERE task_id=$1", f.controllerFixture.task)
			}
			if mode == "scope-changed" {
				dbfx.Exec(t, "UPDATE agent SET archived_at=now() WHERE id=$1", f.task.AgentID)
			}
			var sample *engineeringReadinessObservation
			f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "team-routing":
					return json.RawMessage(`{"owned":false,"binding":null,"profile":null}`), nil
				case "repair-dispatch-readiness":
					if mode == "business-unavailable" {
						return nil, os.ErrNotExist
					}
					state := "eligible"
					reason := "prepared-entry"
					if mode == "human-wait" {
						state = "waiting"
						reason = "human-answers-pending"
					}
					if mode == "paused" {
						state = "paused"
						reason = "business-held"
					}
					return json.Marshal(map[string]any{"workspaceId": testWorkspaceID, "issueId": f.issue, "target_hash": f.published.Publication.TargetHash, "application_hash": f.application.Hash, "ready_hash": f.published.Ready.Hash, "entry_task_id": f.published.Publication.TaskID, "agent_id": uuidToString(f.task.AgentID), "user_id": testUserID, "hash": strings.Repeat("a", 64), "state": state, "reason": reason, "task_id": uuidToString(f.task.ID), "draft_id": f.application.DraftID, "revision": 1, "sequence": 5})
				default:
					t.Fatalf("readiness mutated business state: %v", input["action"])
					return nil, nil
				}
			}}
			f.h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "handoff-observing":
					return json.Marshal([]map[string]string{{"case_id": "fixture-case"}})
				case "handoff-context":
					if mode == "stopped" {
						return nil, os.ErrPermission
					}
					return json.Marshal(f.management)
				case "handoff-watch":
					raw, _ := json.Marshal(input["payload"])
					sample = &engineeringReadinessObservation{}
					if json.Unmarshal(raw, sample) != nil || sample.Hash != engineeringReadinessHash(*sample) || sample.PublicationHash != f.published.Publication.Hash {
						t.Fatal("readiness lost its actual publication identity")
					}
					return json.RawMessage(`{"stall_due":false}`), nil
				default:
					t.Fatalf("sampling created a failure or closure: %v", input["action"])
					return nil, nil
				}
			}}
			root, err := os.MkdirTemp("", "recovery-watch-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(root)
			f.h.cfg.EngineeringDatabasePath = filepath.Join(root, "business.sqlite")
			if err = f.h.StartEngineeringLocalControl(ctx); err != nil {
				t.Fatal(err)
			}
			f.h.EngineeringTakeoverControl = &engineering.LocalControlClient{Socket: f.h.cfg.EngineeringDatabasePath + ".control.sock"}
			err = f.h.ReconcileEngineeringRecoveryReadiness(ctx, engineeringAdminAuthority{OwnerID: "watch-host", Token: 2})
			if mode == "stopped" {
				if err == nil || sample != nil {
					t.Fatal("stopped intent recorded a readiness sample")
				}
				return
			}
			if err != nil || sample == nil {
				t.Fatal("missing readiness observation", err)
			}
			want := "waiting"
			switch mode {
			case "runnable":
				want = "runnable"
			case "running":
				want = "executing"
			case "paused":
				want = "paused"
			case "scope-changed", "business-unavailable":
				want = "source-changed"
			}
			if sample.Readiness != want {
				t.Fatalf("%s readiness=%s reason=%s", mode, sample.Readiness, sample.Reason)
			}
			actual, e := f.h.Queries.GetAgentTask(ctx, f.task.ID)
			if e != nil {
				t.Fatal(e)
			}
			expected := "queued"
			if mode == "running" {
				expected = "running"
			}
			if mode == "resource-wait" {
				expected = "waiting_local_directory"
			}
			if actual.Status != expected {
				t.Fatal("sampling claimed or cancelled native work")
			}
		})
	}
}

func TestEngineeringDispatchPreviewMatchesNativeQueue(t *testing.T) {
	for _, mode := range []string{"free", "no-evidence", "full", "stale-poll", "future-poll", "offline", "stale-heartbeat", "agent-cap", "runtime-cap", "same-issue-running", "higher-priority", "two-slots", "other-runtime-priority", "other-runtime-two-slots", "runtime-set-replaced", "owner-changed", "invalid-wakeup"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			f := newRecoveryWatchFixture(t)
			runtime, err := f.h.Queries.GetAgentRuntime(ctx, f.task.RuntimeID)
			if err != nil {
				t.Fatal(err)
			}
			runtimes := []db.AgentRuntime{runtime}
			ids := []string{uuidToString(runtime.ID)}
			slots := 1
			now := time.Now()
			at := now
			if mode == "full" {
				slots = 0
			}
			if mode == "stale-poll" {
				at = now.Add(-31 * time.Second)
			}
			if mode == "future-poll" {
				at = now.Add(time.Second)
			}
			if mode == "agent-cap" || mode == "runtime-cap" || mode == "same-issue-running" {
				issue := f.issue
				if mode != "same-issue-running" {
					issue = dbfx.Issue(t, "capacity fixture")
				}
				dbfx.Task(t, uuidToString(f.task.AgentID), testutil.Cols{"runtime_id": runtime.ID, "issue_id": issue, "status": "running"})
				if mode == "agent-cap" {
					dbfx.Exec(t, "UPDATE agent SET max_concurrent_tasks=1 WHERE id=$1", f.task.AgentID)
				}
				if mode == "runtime-cap" {
					dbfx.Exec(t, "UPDATE agent_runtime SET max_concurrent_tasks=1 WHERE id=$1", runtime.ID)
				}
			}
			if mode == "higher-priority" || mode == "two-slots" || mode == "invalid-wakeup" {
				otherAgent := dbfx.Agent(t, "priority agent", uuidToString(runtime.ID))
				cols := testutil.Cols{"runtime_id": runtime.ID, "priority": 100, "status": "queued"}
				if mode == "invalid-wakeup" {
					cols["context"] = json.RawMessage(`{"wakeup_id":"` + uuid.NewString() + `","wakeup_revision":1}`)
				}
				dbfx.Task(t, otherAgent, cols)
				if mode == "two-slots" {
					slots = 2
				}
			}
			if strings.HasPrefix(mode, "other-runtime-") || mode == "runtime-set-replaced" {
				otherID := dbfx.Runtime(t, "shared machine runtime", testutil.Cols{"daemon_id": runtime.DaemonID.String, "owner_id": runtime.OwnerID, "provider": "claude", "runtime_mode": "local", "status": "online", "last_seen_at": testutil.Raw("now()")})
				other, e := f.h.Queries.GetAgentRuntime(ctx, parseUUID(otherID))
				if e != nil {
					t.Fatal(e)
				}
				runtimes = append(runtimes, other)
				ids = append(ids, otherID)
				agent := dbfx.Agent(t, "other machine role", otherID)
				dbfx.Task(t, agent, testutil.Cols{"runtime_id": otherID, "priority": 100, "status": "queued"})
				if mode == "other-runtime-two-slots" {
					slots = 2
				}
			}
			now = time.Now()
			at = now
			if mode == "stale-poll" {
				at = now.Add(-31 * time.Second)
			}
			if mode == "future-poll" {
				at = now.Add(time.Second)
			}
			if mode != "no-evidence" {
				f.h.TaskService.EngineeringCapacity.Observe(runtimes, slots, at)
			}
			if mode == "runtime-set-replaced" {
				f.h.TaskService.EngineeringCapacity.Observe(runtimes[1:], 1, now)
			}
			if mode == "offline" {
				dbfx.Exec(t, "UPDATE agent_runtime SET status='offline' WHERE id=$1", runtime.ID)
			}
			if mode == "stale-heartbeat" {
				dbfx.Exec(t, "UPDATE agent_runtime SET last_seen_at=now()-interval '10 minutes' WHERE id=$1", runtime.ID)
			}
			if mode == "owner-changed" {
				user := dbfx.User(t, "new runtime owner", uuid.NewString()+"@example.invalid")
				dbfx.Exec(t, "UPDATE agent_runtime SET owner_id=$2 WHERE id=$1", runtime.ID, user)
			}
			value, err := f.h.TaskService.InspectEngineeringDispatch(ctx, f.task, now)
			if err != nil {
				t.Fatal(err)
			}
			runnable := mode == "free" || mode == "two-slots" || mode == "other-runtime-two-slots" || mode == "invalid-wakeup"
			if value.Runnable != runnable {
				t.Fatalf("preview=%v reason=%s", value.Runnable, value.Reason)
			}
			stored, e := f.h.Queries.GetAgentTask(ctx, f.task.ID)
			if e != nil || stored.Status != "queued" || stored.DispatchedAt.Valid {
				t.Fatal("preview changed the native queue", e)
			}
			if runnable {
				runtimeIDs := make([]pgtype.UUID, 0, len(ids))
				for _, id := range ids {
					runtimeIDs = append(runtimeIDs, parseUUID(id))
				}
				claimed, e := f.h.TaskService.ClaimTasksForRuntimes(ctx, runtimeIDs, slots)
				if e != nil {
					t.Fatal(e)
				}
				found := false
				for _, task := range claimed {
					if task.ID == f.task.ID {
						found = true
					}
				}
				if !found {
					t.Fatal("read-only eligibility disagreed with the ordinary native claim")
				}
			}
		})
	}
}

func TestEngineeringReadinessHashMatchesKernel(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/command-chain/test-helpers/repair-readiness.json")
	if err != nil {
		t.Fatal(err)
	}
	var value engineeringReadinessObservation
	if json.Unmarshal(raw, &value) != nil || engineeringReadinessHash(value) != value.Hash {
		t.Fatal("native and kernel readiness witnesses differ")
	}
	value.Reason = "changed"
	if engineeringReadinessHash(value) == value.Hash {
		t.Fatal("readiness digest lost its native reason")
	}
}

func TestEngineeringDaemonCapacityUsesAuthorizedPolls(t *testing.T) {
	ctx := context.Background()
	f := newRecoveryWatchFixture(t)
	runtime, err := f.h.Queries.GetAgentRuntime(ctx, f.task.RuntimeID)
	if err != nil {
		t.Fatal(err)
	}
	f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(map[string]any) (json.RawMessage, error) {
		t.Fatal("capacity poll unexpectedly prepared a provider task")
		return nil, nil
	}}
	poll := func(ids []string, max int) {
		request := newOwnerDaemonRequest(http.MethodPost, "/api/daemon/tasks/claim", map[string]any{"daemon_id": runtime.DaemonID.String, "runtime_ids": ids, "max_tasks": max})
		testutil.Call(t, f.h.ClaimTasksByRuntime, request).Want(http.StatusOK)
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='deferred',fire_at=now()+interval '1 hour' WHERE id=$1", f.task.ID)
	poll([]string{uuidToString(runtime.ID)}, 1)
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='queued',fire_at=NULL WHERE id=$1", f.task.ID)
	ready, err := f.h.TaskService.InspectEngineeringDispatch(ctx, f.task, time.Now())
	if err != nil || !ready.Runnable {
		t.Fatal("authenticated idle poll did not record a free slot", err, ready)
	}
	poll([]string{uuid.NewString()}, 0)
	ready, err = f.h.TaskService.InspectEngineeringDispatch(ctx, f.task, time.Now())
	if err != nil || !ready.Runnable {
		t.Fatal("unresolved runtime poll changed authorized machine capacity", err)
	}
	poll([]string{uuidToString(runtime.ID)}, 0)
	ready, err = f.h.TaskService.InspectEngineeringDispatch(ctx, f.task, time.Now())
	if err != nil || ready.Runnable {
		t.Fatal("zero-capacity poll remained runnable", err)
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='deferred',fire_at=now()+interval '1 hour' WHERE id=$1", f.task.ID)
	request := withURLParam(newOwnerDaemonRequest(http.MethodPost, "/api/daemon/runtime/claim", nil), "runtimeId", uuidToString(runtime.ID))
	recorder := httptest.NewRecorder()
	f.h.ClaimTaskByRuntime(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatal("legacy idle poll failed", recorder.Code)
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='queued',fire_at=NULL WHERE id=$1", f.task.ID)
	ready, err = f.h.TaskService.InspectEngineeringDispatch(ctx, f.task, time.Now())
	if err != nil || !ready.Runnable {
		t.Fatal("legacy idle poll did not retain its authorized slot", err, ready)
	}
	task, err := f.h.Queries.GetAgentTask(ctx, f.task.ID)
	if err != nil || task.Status != "queued" || task.DispatchedAt.Valid {
		t.Fatal("capacity recording claimed business work", err)
	}
}
