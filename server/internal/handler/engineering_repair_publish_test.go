package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Actual PostgreSQL and private control socket; business/management ports are
// simulated here. Node tests own their durable receipts and task activation.
func TestEngineeringRepairPublication(t *testing.T) {
	for _, mode := range []string{"success", "ack-retry", "ready-failure", "ready-scope", "ready-hash", "changed-version", "stopped-after-ready", "task-insert-failure", "ledger-insert-failure", "queued-admission", "intent-while-waiting"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f := physicalTakeoverFixture(t)
			dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='quiesced',no_provider_started=true WHERE controller_id=$1", f.controller)
			result, err := f.h.DrainEngineeringProject(ctx, f.body)
			if err != nil {
				t.Fatal(err)
			}
			progress := result.(engineeringRepairProgress)
			if progress.Phase != "owned" {
				t.Fatal("fixture has no physical ownership")
			}
			native := mustControllerTask(t, f.controllerFixture)
			beforeIssue, e := f.h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: parseUUID(testWorkspaceID), ID: parseUUID(f.issue)})
			if e != nil {
				t.Fatal(e)
			}
			item := engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: f.issue, AgentID: uuidToString(native.AgentID), UserID: testUserID, TaskID: uuid.NewString(), ExpectedRevision: 1, ExpectedSequence: 8, Reason: "repair_ready"}
			draftID := uuid.NewString()
			targetHash := strings.ReplaceAll(uuid.NewString(), "-", "") + strings.ReplaceAll(uuid.NewString(), "-", "")
			prepared := engineeringHandoffPreparation{Prepared: true, Hash: strings.Repeat("d", 64), TargetHash: targetHash, Continuation: item, Kind: "yaml", DraftID: &draftID}
			expected := "workspace-content-v1:" + strings.Repeat("a", 40) + ":" + strings.Repeat("b", 64)
			current := map[string]any{}
			for k, v := range f.current {
				current[k] = v
			}
			current["current_intent_revision"] = 1
			current["preparation"] = prepared
			current["target_hash"] = targetHash
			current["target"] = map[string]any{"verificationAttemptId": "verified-native-checks", "expectedVersion": expected, "workspaceBinding": map[string]string{"targetsHash": progress.TargetsHash}}
			var reservation engineeringHandoffReservation
			var application engineeringHandoffApplication
			staged, readyCalled, published := false, false, false
			acks, readyCalls, oldSourceCalls := 0, 0, 0
			var stopped atomic.Bool
			f.h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "handoff-pending":
					return json.Marshal([]any{map[string]string{"case_id": "fixture-case"}})
				case "handoff-context":
					if stopped.Load() || mode == "stopped-after-ready" && readyCalled {
						return nil, fmt.Errorf("management stopped")
					}
					return json.Marshal(current)
				case "handoff-prepared":
					current["preparation"] = input["payload"]
					return json.Marshal(input["payload"])
				case "handoff-reserved":
					reservation = input["payload"].(engineeringHandoffReservation)
					current["reservation"] = reservation
					return json.Marshal(reservation)
				case "handoff-staged":
					encoded, _ := json.Marshal(input["payload"])
					if e := json.Unmarshal(encoded, &application); e != nil {
						return nil, e
					}
					current["application"] = application
					return json.Marshal(application)
				case "handoff-published":
					acks++
					published = true
					if mode == "ack-retry" && acks == 1 {
						return nil, fmt.Errorf("acknowledgement interrupted after native commit")
					}
					return json.Marshal(input["payload"])
				}
				return nil, fmt.Errorf("unexpected publication management action %v", input["action"])
			}}
			f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "repair-source":
					oldSourceCalls++
					if published {
						return nil, fmt.Errorf("successor has advanced beyond its old staged root")
					}
					source := map[string]any{}
					for k, v := range f.source {
						source[k] = v
					}
					if staged {
						source["checkpoint_state"] = "staged"
						source["handoff_target_hash"] = targetHash
						source["handoff_application_hash"] = application.Hash
					}
					return json.Marshal(source)
				case "team-routing":
					return json.RawMessage(`{"binding":null}`), nil
				case "repair-handoff-prepare":
					return json.Marshal(prepared)
				case "repair-workspace-version":
					version := expected
					if readyCalled && mode == "changed-version" {
						version = "changed"
					}
					return json.Marshal(map[string]string{"workspace_version": version})
				case "repair-handoff-stage":
					staged = true
					application = engineeringHandoffApplication{Staged: true, HoldRetained: true, Hash: strings.Repeat("e", 64), TargetHash: targetHash, PreparationHash: prepared.Hash, ReservationHash: reservation.Hash, ExpectedVersion: expected, Continuation: item, DraftID: &draftID}
					return json.Marshal(application)
				case "repair-handoff-ready":
					readyCalled = true
					readyCalls++
					// Nothing from this ownership transaction is visible to another connection.
					var phase string
					var count int
					if err := testPool.QueryRow(ctx, "SELECT phase FROM engineering_repair_handoff WHERE target_hash=$1", targetHash).Scan(&phase); err != nil || phase != "reserved" {
						t.Fatal("reservation released before commit", err)
					}
					if err := testPool.QueryRow(ctx, "SELECT count(*) FROM engineering_repair_fence WHERE project_id=$1", f.project).Scan(&count); err != nil || count != 1 {
						t.Fatal("fence released before commit", err)
					}
					if err := testPool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE id=$1", item.TaskID).Scan(&count); err != nil || count != 0 {
						t.Fatal("successor exposed before commit", err)
					}
					if mode == "ready-failure" {
						return nil, fmt.Errorf("business readiness failed")
					}
					r := engineeringHandoffReady{Ready: true, TargetHash: targetHash, ReservationHash: reservation.Hash, ApplicationHash: application.Hash, ExpectedVersion: expected, Continuation: item}
					if mode == "ready-scope" {
						r.Continuation.TaskID = uuid.NewString()
					}
					r.Hash = engineeringHandoffReadyHash(r)
					if mode == "ready-hash" {
						r.Hash = strings.Repeat("f", 64)
					}
					return json.Marshal(r)
				}
				return nil, fmt.Errorf("unexpected publication business action %v", input["action"])
			}}
			root, err := os.MkdirTemp("", "handoff-publish-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(root)
			f.h.cfg.EngineeringDatabasePath = filepath.Join(root, "b.sqlite")
			if err = f.h.StartEngineeringLocalControl(ctx); err != nil {
				t.Fatal(err)
			}
			f.h.EngineeringTakeoverControl = &engineering.LocalControlClient{Socket: f.h.cfg.EngineeringDatabasePath + ".control.sock"}
			authority := engineeringAdminAuthority{OwnerID: "current-host", Token: 2}
			call := func(action string) error {
				_, e := f.h.EngineeringTakeoverControl.Call(ctx, map[string]any{"action": action, "authority": authority, "case_id": "fixture-case"})
				return e
			}
			if mode == "success" || mode == "ack-retry" {
				err = f.h.ReconcileEngineeringRepairHandoffs(ctx, authority)
			} else {
				if e := call("reserve-handoff"); e != nil {
					t.Fatal(e)
				}
				if e := call("stage-handoff"); e != nil {
					t.Fatal(e)
				}
				if mode == "queued-admission" {
					_, e := testPool.Exec(ctx, "INSERT INTO agent_task_queue(id,agent_id,runtime_id,issue_id,status) VALUES($1,$2,$3,$4,'queued')", uuid.NewString(), native.AgentID, native.RuntimeID, parseUUID(f.issue))
					var pg *pgconn.PgError
					if !errors.As(e, &pg) || pg.Code != "55000" {
						t.Fatal("reserved project admitted an unrelated queued task", e)
					}
				}
				if mode == "task-insert-failure" || mode == "ledger-insert-failure" {
					name := "reject_publication_" + strings.ReplaceAll(uuid.NewString(), "-", "")
					table := "agent_task_queue"
					predicate := "NEW.id='" + item.TaskID + "'::uuid"
					if mode == "ledger-insert-failure" {
						table = "engineering_repair_publication"
						predicate = "NEW.target_hash='" + targetHash + "'"
					}
					dbfx.Exec(t, fmt.Sprintf("CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF %s THEN RAISE EXCEPTION 'fixture transaction failure'; END IF; RETURN NEW; END $$", name, predicate))
					dbfx.Exec(t, fmt.Sprintf("CREATE TRIGGER %s BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION %s()", name, table, name))
					defer dbfx.Exec(t, fmt.Sprintf("DROP FUNCTION %s() CASCADE", name))
				}
				if mode == "intent-while-waiting" {
					hold, e := testPool.Begin(ctx)
					if e != nil {
						t.Fatal(e)
					}
					defer hold.Rollback(context.Background())
					if _, e = db.New(hold).LockEngineeringProject(ctx, db.LockEngineeringProjectParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)}); e != nil {
						t.Fatal(e)
					}
					var holder int
					if e = hold.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&holder); e != nil {
						t.Fatal(e)
					}
					done := make(chan error, 1)
					go func() { done <- call("publish-handoff") }()
					blocked := false
					for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
						var n int
						if e = testPool.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", holder).Scan(&n); e != nil {
							t.Fatal(e)
						}
						if n > 0 {
							blocked = true
							break
						}
						time.Sleep(10 * time.Millisecond)
					}
					if !blocked {
						t.Fatal("publication did not wait for project admission")
					}
					stopped.Store(true)
					if e = hold.Rollback(ctx); e != nil {
						t.Fatal(e)
					}
					select {
					case err = <-done:
					case <-time.After(4 * time.Second):
						t.Fatal("publication did not settle after admission release")
					}
					if readyCalls != 0 {
						t.Fatal("stopped authorization created readiness after admission wait")
					}
				} else {
					err = call("publish-handoff")
				}
			}
			success := mode == "success" || mode == "ack-retry" || mode == "queued-admission"
			if mode == "ack-retry" {
				if err == nil {
					t.Fatal("lost acknowledgement was accepted")
				}
				before := oldSourceCalls
				current["current_intent_revision"] = 2
				dbfx.Exec(t, "UPDATE agent_task_queue SET status='cancelled',completed_at=now() WHERE id=$1", item.TaskID)
				err = f.h.ReconcileEngineeringRepairHandoffs(ctx, authority)
				if oldSourceCalls != before || readyCalls != 1 || acks != 2 {
					t.Fatal("replay recreated readiness or reread a mutable old root", oldSourceCalls, before, readyCalls, acks)
				}
			}
			if success && err != nil {
				t.Fatal(err)
			}
			if !success && (err == nil || acks != 0) {
				t.Fatal("changed publication accepted", mode, err, acks)
			}
			var tasks, receipts, fences int
			var phase string
			for _, check := range []struct {
				query string
				arg   any
				out   *int
			}{{"SELECT count(*) FROM agent_task_queue WHERE id=$1", item.TaskID, &tasks}, {"SELECT count(*) FROM engineering_repair_publication WHERE target_hash=$1", targetHash, &receipts}, {"SELECT count(*) FROM engineering_repair_fence WHERE project_id=$1", f.project, &fences}} {
				if e := testPool.QueryRow(ctx, check.query, check.arg).Scan(check.out); e != nil {
					t.Fatal(e)
				}
			}
			saved, e := f.h.Queries.GetEngineeringRepairHandoff(ctx, targetHash)
			if e != nil {
				t.Fatal(e)
			}
			phase = saved.Phase
			if success {
				if tasks != 1 || receipts != 1 || fences != 0 || phase != "published" {
					t.Fatal("native publication was not atomic", tasks, receipts, fences, phase)
				}
				task, e := f.h.Queries.GetAgentTask(ctx, parseUUID(item.TaskID))
				if e != nil {
					t.Fatal(e)
				}
				if task.AgentID != native.AgentID || task.RuntimeID != native.RuntimeID || uuidToString(task.OriginatorUserID) != testUserID {
					t.Fatal("successor lost frozen native identity")
				}
				if mode == "ack-retry" && task.Status != "cancelled" {
					t.Fatal("terminal successor re-enqueued")
				}
				issue, e := f.h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: parseUUID(testWorkspaceID), ID: parseUUID(f.issue)})
				if e != nil {
					t.Fatal(e)
				}
				if issue.AssigneeID != beforeIssue.AssigneeID || issue.AssigneeType != beforeIssue.AssigneeType {
					t.Fatal("publication changed assignment")
				}
				row, e := f.h.Queries.GetEngineeringRepairPublication(ctx, targetHash)
				if e != nil {
					t.Fatal(e)
				}
				var receipt engineeringHandoffPublished
				if json.Unmarshal([]byte(row.Payload), &receipt) != nil || engineeringHandoffPublicationHash(receipt.Publication) != receipt.Publication.Hash {
					t.Fatal("invalid immutable publication")
				}
			} else if tasks != 0 || receipts != 0 || fences != 1 || phase != "reserved" {
				t.Fatal("failed publication released ownership or leaked task", tasks, receipts, fences, phase)
			}
			if _, e := f.h.Queries.GetAgentTask(ctx, parseUUID(item.TaskID)); !success && !errors.Is(e, pgx.ErrNoRows) {
				t.Fatal(e)
			}
		})
	}
}

func TestEngineeringHandoffPublicationHashMatchesKernel(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/command-chain/test-helpers/repair-handoff-publication.json")
	if err != nil {
		t.Fatal(err)
	}
	var value engineeringHandoffPublished
	if err = json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	if engineeringHandoffReadyHash(value.Ready) != value.Ready.Hash || engineeringHandoffPublicationHash(value.Publication) != value.Publication.Hash {
		t.Fatal("native publication digest differs from shared UTF-8 witness")
	}
	value.Ready.Continuation.ExpectedSequence++
	value.Publication.TaskID = uuid.NewString()
	if engineeringHandoffReadyHash(value.Ready) == value.Ready.Hash || engineeringHandoffPublicationHash(value.Publication) == value.Publication.Hash {
		t.Fatal("publication digest omitted native task or checkpoint identity")
	}
}
