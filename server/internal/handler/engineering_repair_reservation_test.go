package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestEngineeringHandoffReservationHashMatchesKernel(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/command-chain/test-helpers/repair-handoff-reservation.json")
	if err != nil {
		t.Fatal(err)
	}
	var value engineeringHandoffReservation
	if err = json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	if engineeringHandoffReservationHash(value) != value.Hash {
		t.Fatal("native reservation digest differs from shared UTF-8 witness")
	}
	value.Continuation.ExpectedSequence++
	if engineeringHandoffReservationHash(value) == value.Hash {
		t.Fatal("reservation hash omitted successor checkpoint")
	}
}

func TestEngineeringHandoffReservationRevalidatesAfterAdmissionWait(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	f := physicalTakeoverFixture(t)
	dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='quiesced',no_provider_started=true WHERE controller_id=$1", f.controller)
	raw, err := f.h.DrainEngineeringProject(ctx, f.body)
	if err != nil {
		t.Fatal(err)
	}
	progress := raw.(engineeringRepairProgress)
	encoded, err := json.Marshal(f.current)
	if err != nil {
		t.Fatal(err)
	}
	var current engineeringHandoffContext
	if err = json.Unmarshal(encoded, &current); err != nil {
		t.Fatal(err)
	}
	current.TargetHash = strings.Repeat("c", 64)
	current.Target, _ = json.Marshal(map[string]any{"verificationAttemptId": "verification", "expectedVersion": "workspace-content-v1:" + strings.Repeat("a", 40) + ":" + strings.Repeat("b", 64), "workspaceBinding": map[string]string{"targetsHash": progress.TargetsHash}})
	pin, err := f.h.engineeringSourceForCurrent(ctx, current.engineeringTakeoverCurrent)
	if err != nil {
		t.Fatal(err)
	}
	native := mustControllerTask(t, f.controllerFixture)
	prepared := engineeringHandoffPreparation{Prepared: true, Hash: strings.Repeat("d", 64), TargetHash: current.TargetHash, Continuation: engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: f.issue, AgentID: uuidToString(native.AgentID), UserID: testUserID, TaskID: uuid.NewString(), ExpectedRevision: 1, ExpectedSequence: 8, Reason: "repair_ready"}}
	hold, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer hold.Rollback(context.Background())
	if _, err = db.New(hold).LockEngineeringProject(ctx, db.LockEngineeringProjectParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID}); err != nil {
		t.Fatal(err)
	}
	var holder int
	if err = hold.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&holder); err != nil {
		t.Fatal(err)
	}
	var changed atomic.Bool
	done := make(chan error, 1)
	go func() {
		_, err := f.h.reserveEngineeringRepairHandoff(ctx, current, pin, prepared, func() error {
			if changed.Load() {
				return fmt.Errorf("source authority changed during admission wait")
			}
			return nil
		})
		done <- err
	}()
	blocked := false
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		var count int
		if err = testPool.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", holder).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			blocked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("reservation never waited for native admission lock")
	}
	changed.Store(true)
	if err = hold.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err == nil {
			t.Fatal("stale authorization reserved work after admission wait")
		}
	case <-ctx.Done():
		t.Fatal("reservation did not finish after admission lock release")
	}
	var count int
	if err = testPool.QueryRow(ctx, "SELECT count(*) FROM engineering_repair_handoff WHERE project_id=$1", f.project).Scan(&count); err != nil || count != 0 {
		t.Fatal("stale authorization persisted a reservation", err)
	}
}

func TestEngineeringNativeHandoffReservation(t *testing.T) {
	for _, mode := range []string{"success", "ack-retry", "missing-preparation", "changed-proposal", "changed-version", "new-terminal-writer", "intent-changes", "stopped", "existing-task", "other-reservation", "corrupt-reservation", "admission-without-fence"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f := physicalTakeoverFixture(t)
			dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='quiesced',no_provider_started=true WHERE controller_id=$1", f.controller)
			raw, err := f.h.DrainEngineeringProject(ctx, f.body)
			if err != nil {
				t.Fatal(err)
			}
			progress := raw.(engineeringRepairProgress)
			if progress.Phase != "owned" {
				t.Fatal("fixture is not physically owned")
			}
			task := mustControllerTask(t, f.controllerFixture)
			item := engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: f.issue, AgentID: uuidToString(task.AgentID), UserID: testUserID, TaskID: uuid.NewString(), ExpectedRevision: 1, ExpectedSequence: 8, Reason: "repair_ready"}
			draftID := uuid.NewString()
			prepared := engineeringHandoffPreparation{Prepared: true, Hash: strings.Repeat("d", 64), TargetHash: strings.Repeat("c", 64), Continuation: item, Kind: "yaml", DraftID: &draftID}
			expected := "workspace-content-v1:" + strings.Repeat("a", 40) + ":" + strings.Repeat("b", 64)
			current := map[string]any{}
			for key, value := range f.current {
				current[key] = value
			}
			current["current_intent_revision"] = 1
			current["target_hash"] = prepared.TargetHash
			current["preparation"] = prepared
			current["target"] = map[string]any{"verificationAttemptId": "verified-native-checks", "expectedVersion": expected, "workspaceBinding": map[string]string{"targetsHash": progress.TargetsHash}}
			if mode == "missing-preparation" {
				current["preparation"] = nil
			}
			acks := 0
			var acknowledged engineeringHandoffReservation
			f.h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "handoff-context":
					if mode == "stopped" {
						return nil, fmt.Errorf("management intent stopped")
					}
					return json.Marshal(current)
				case "handoff-pending":
					return json.Marshal([]any{map[string]string{"case_id": "fixture-case"}})
				case "handoff-prepared":
					current["preparation"] = input["payload"]
					return json.Marshal(input["payload"])
				case "handoff-reserved":
					acks++
					value, ok := input["payload"].(engineeringHandoffReservation)
					if !ok {
						t.Fatal("native reservation is not host-derived")
					}
					acknowledged = value
					if mode == "ack-retry" && acks == 1 {
						return nil, fmt.Errorf("fixture ack interrupted after native commit")
					}
					return json.Marshal(value)
				}
				return nil, fmt.Errorf("unexpected reservation management action %v", input["action"])
			}}
			injected := false
			f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "repair-source":
					return json.Marshal(f.source)
				case "team-routing":
					return json.RawMessage(`{"binding":null}`), nil
				case "repair-handoff-prepare":
					value := prepared
					if mode == "changed-proposal" {
						value.Hash = strings.Repeat("e", 64)
					}
					if mode == "new-terminal-writer" && !injected {
						injected = true
						dbfx.Task(t, uuidToString(task.AgentID), testutil.Cols{"runtime_id": uuidToString(task.RuntimeID), "issue_id": f.issue, "status": "cancelled", "dispatched_at": testutil.Raw("now()"), "completed_at": testutil.Raw("now()")})
					}
					return json.Marshal(value)
				case "repair-workspace-version":
					version := expected
					if mode == "changed-version" {
						version = "changed"
					}
					if mode == "intent-changes" {
						current["current_intent_revision"] = 2
					}
					return json.Marshal(map[string]string{"workspace_version": version})
				}
				return nil, fmt.Errorf("unexpected reservation business action %v", input["action"])
			}}
			if mode == "existing-task" {
				dbfx.Task(t, uuidToString(task.AgentID), testutil.Cols{"id": item.TaskID, "runtime_id": uuidToString(task.RuntimeID), "issue_id": f.issue, "status": "cancelled"})
			}
			if mode == "other-reservation" || mode == "corrupt-reservation" {
				target := prepared.TargetHash
				if mode == "other-reservation" {
					target = strings.Repeat("f", 64)
				}
				dbfx.Exec(t, "INSERT INTO engineering_repair_handoff(target_hash,workspace_id,project_id,task_id,payload) VALUES($1,$2,$3,$4,'{}')", target, testWorkspaceID, f.project, uuid.NewString())
			}
			var before int
			if err = testPool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", f.issue).Scan(&before); err != nil {
				t.Fatal(err)
			}
			socketRoot, err := os.MkdirTemp("", "handoff-reserve-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(socketRoot)
			f.h.cfg.EngineeringDatabasePath = filepath.Join(socketRoot, "b.sqlite")
			if err = f.h.StartEngineeringLocalControl(ctx); err != nil {
				t.Fatal(err)
			}
			f.h.EngineeringTakeoverControl = &engineering.LocalControlClient{Socket: f.h.cfg.EngineeringDatabasePath + ".control.sock"}
			call := func() error {
				_, err := f.h.EngineeringTakeoverControl.Call(ctx, map[string]any{"action": "reserve-handoff", "authority": engineeringAdminAuthority{OwnerID: "current-host", Token: 2}, "case_id": "fixture-case"})
				return err
			}
			err = call()
			if mode == "ack-retry" {
				if err == nil {
					t.Fatal("interrupted management acknowledgement succeeded")
				}
				first := acknowledged
				// A successor supervisor/intent must replay the original native identity.
				current["current_intent_revision"] = 2
				err = call()
				if acknowledged.Hash != first.Hash || acks != 2 {
					t.Fatal("native reservation was replaced after acknowledgement interruption")
				}
			}
			success := mode == "success" || mode == "ack-retry" || mode == "admission-without-fence"
			if success && err != nil {
				t.Fatal(err)
			}
			if !success && err == nil {
				t.Fatal("changed handoff reserved native work", mode)
			}
			if !success && acks != 0 {
				t.Fatal("changed native reservation reached management acknowledgement")
			}
			if success {
				saved, e := f.h.Queries.GetEngineeringRepairHandoff(ctx, prepared.TargetHash)
				if e != nil {
					t.Fatal(e)
				}
				var receipt engineeringHandoffReservation
				if json.Unmarshal([]byte(saved.Payload), &receipt) != nil || receipt.Hash != acknowledged.Hash || engineeringHandoffReservationHash(receipt) != receipt.Hash || saved.Phase != "reserved" || uuidToString(saved.TaskID) != item.TaskID {
					t.Fatal("native reservation identity was not retained")
				}
			}
			fence, e := f.h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)})
			if e != nil || fence.Phase != "owned" {
				t.Fatal("native reservation released the repair fence", e)
			}
			var after int
			if err = testPool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", f.issue).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if after != before && mode != "new-terminal-writer" {
				t.Fatal("reservation enqueued business work")
			}
			if mode == "admission-without-fence" {
				dbfx.Exec(t, "DELETE FROM engineering_repair_fence WHERE project_id=$1", f.project)
				if err = f.h.Queries.EngineeringRequireProjectAvailable(ctx, parseUUID(f.project)); err == nil {
					t.Fatal("reservation lost project admission barrier without fence")
				}
				if _, err = testPool.Exec(ctx, "UPDATE agent_task_queue SET status='running' WHERE id=$1", f.task); err == nil {
					t.Fatal("reservation admitted a native task before business activation")
				}
				if _, err = testPool.Exec(ctx, "UPDATE project SET name='Changed resource scope' WHERE id=$1", f.project); err == nil {
					t.Fatal("reservation allowed project/resource mutation")
				}
			}
		})
	}
}
