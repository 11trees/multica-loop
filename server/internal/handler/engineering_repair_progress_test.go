package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/engineering/ownership"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Native task/claim/cleanup rows and private control are real. Independent
// management and owner-applied business receipts have their own Node tests.
func TestEngineeringRecoveryProgress(t *testing.T) {
	for _, mode := range []string{"success", "direct-continuation", "continuation", "entry-retry", "entry-unlinked", "continuation-missing-context", "continuation-wrong-hint", "continuation-wrong-draft", "failed-applied", "failed-no-result", "empty-result", "queued", "running", "cancelled", "missing-controller", "unfinished-controller", "wrong-claim", "wrong-task", "missing-event", "unapplied-result", "changed-result", "stopped-after-record", "new-fence", "new-reservation", "progress-ack-retry", "close-ack-lost", "later-work"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f := newTakeoverControlFixture(t)
			original := mustControllerTask(t, f.controllerFixture)
			dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='quiesced',no_provider_started=true WHERE task_id=$1", f.task)
			dbfx.Exec(t, "UPDATE agent_task_queue SET status='cancelled',completed_at=now() WHERE id=$1", f.task)
			t.Cleanup(func() {
				dbfx.Exec(t, "DELETE FROM engineering_run_process WHERE controller_id IN (SELECT controller_id FROM engineering_run_guard WHERE project_id=$1)", f.project)
				dbfx.Exec(t, "DELETE FROM engineering_run_guard WHERE project_id=$1", f.project)
			})
			taskID := dbfx.Task(t, uuidToString(original.AgentID), testutil.Cols{"issue_id": f.issue, "runtime_id": uuidToString(original.RuntimeID), "originator_user_id": testUserID, "accountable_user_id": testUserID, "originator_source": "direct_human", "trigger_evidence_kind": "issue_assignment", "trigger_evidence_ref_id": f.issue, "status": "running", "dispatched_at": testutil.Raw("now()"), "started_at": testutil.Raw("now()")})
			task, err := f.h.Queries.GetAgentTask(ctx, parseUUID(taskID))
			if err != nil {
				t.Fatal(err)
			}
			controller := parseUUID(uuid.NewString())
			store := ownership.Store{Queries: f.h.Queries, Transactions: f.h.TxStarter}
			if mode != "missing-controller" && mode != "queued" {
				if _, err = store.RecordController(ctx, task, parseUUID(testWorkspaceID), ownership.ControllerRequest{Operation: "begin", ControllerID: controller, Provider: "codex", HostID: "progress-fixture", PID: 42, Marker: "fixture-controller"}); err != nil {
					t.Fatal(err)
				}
				if mode != "unfinished-controller" {
					v := true
					if _, err = store.RecordController(ctx, task, parseUUID(testWorkspaceID), ownership.ControllerRequest{Operation: "end", ControllerID: controller, HostID: "progress-fixture", NoProviderStarted: &v}); err != nil {
						t.Fatal(err)
					}
				}
			}
			if mode == "queued" {
				dbfx.Exec(t, "UPDATE agent_task_queue SET status='queued',dispatched_at=NULL,started_at=NULL,completed_at=NULL WHERE id=$1", taskID)
			} else if mode != "running" {
				status := "completed"
				if mode == "cancelled" {
					status = "cancelled"
				}
				if strings.HasPrefix(mode, "failed-") {
					status = "failed"
				}
				dbfx.Exec(t, "UPDATE agent_task_queue SET status=$2,completed_at=now() WHERE id=$1", taskID, status)
			}
			item := engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: f.issue, TaskID: taskID, AgentID: uuidToString(task.AgentID), UserID: testUserID, ExpectedRevision: 1, ExpectedSequence: 5, Reason: "repair_ready"}
			target := strings.ReplaceAll(uuid.NewString(), "-", "") + strings.ReplaceAll(uuid.NewString(), "-", "")
			version := "workspace-content-v1:" + strings.Repeat("a", 40) + ":" + strings.Repeat("b", 64)
			r := engineeringHandoffReservation{Reserved: true, CaseID: "fixture-case", VerificationAttemptID: "verification", TargetHash: target, PreparationHash: strings.Repeat("d", 64), ProjectID: f.project, ExpectedVersion: version, Continuation: item}
			r.Hash = engineeringHandoffReservationHash(r)
			encoded, _ := json.Marshal(r)
			if _, err = f.h.Queries.CreateEngineeringRepairHandoffReservation(ctx, db.CreateEngineeringRepairHandoffReservationParams{TargetHash: target, WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project), TaskID: parseUUID(taskID), Payload: string(encoded)}); err != nil {
				t.Fatal(err)
			}
			dbfx.Exec(t, "UPDATE engineering_repair_handoff SET phase='published' WHERE target_hash=$1", target)
			draftID, draftHash := uuid.NewString(), strings.Repeat("f", 64)
			a := engineeringHandoffApplication{Staged: true, HoldRetained: true, Hash: strings.Repeat("e", 64), TargetHash: target, PreparationHash: r.PreparationHash, ReservationHash: r.Hash, ExpectedVersion: version, Continuation: item, DraftID: &draftID}
			if mode == "direct-continuation" {
				a.DraftID = nil
			}
			ready := engineeringHandoffReady{Ready: true, TargetHash: target, ReservationHash: r.Hash, ApplicationHash: a.Hash, ExpectedVersion: version, Continuation: item}
			ready.Hash = engineeringHandoffReadyHash(ready)
			publication := engineeringHandoffPublication{Published: true, CaseID: r.CaseID, VerificationAttemptID: r.VerificationAttemptID, TargetHash: target, ReservationHash: r.Hash, ApplicationHash: a.Hash, ReadyHash: ready.Hash, TaskID: taskID, WorkspaceID: testWorkspaceID, IssueID: f.issue, AgentID: item.AgentID, UserID: testUserID, RuntimeID: uuidToString(task.RuntimeID)}
			publication.Hash = engineeringHandoffPublicationHash(publication)
			published := engineeringHandoffPublished{Ready: ready, Publication: publication}
			payload, _ := json.Marshal(published)
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
			business := engineeringBusinessProgress{Applied: true, CaseID: r.CaseID, VerificationAttemptID: r.VerificationAttemptID, TargetHash: target, ApplicationHash: a.Hash, ReadyHash: ready.Hash, WorkspaceID: testWorkspaceID, IssueID: f.issue, TaskID: taskID, AgentID: item.AgentID, AttemptID: taskID + ":" + strconv.FormatInt(task.DispatchedAt.Time.UnixMicro(), 10), Chain: "verification", DraftID: &draftID, DraftHash: &draftHash, ResultID: "new-ordinary-result", ResultHash: strings.Repeat("1", 64), CompletionEventHash: strings.Repeat("2", 64), Revision: 1, Sequence: 10}

			if mode == "direct-continuation" || strings.HasPrefix(mode, "continuation") || strings.HasPrefix(mode, "entry-") {
				hint := engineeringEntryRecoveryHint(ready, a.DraftID)
				hint.Kind = "continuation"
				hint.Sequence++
				if strings.HasPrefix(mode, "entry-") {
					hint.Kind = "entry"
					hint.Sequence = item.ExpectedSequence
				}
				hint.Hash = hint.Digest()
				contextJSON, _ := json.Marshal(map[string]any{"engineering_recovery": hint})
				cols := testutil.Cols{"issue_id": f.issue, "runtime_id": uuidToString(task.RuntimeID), "originator_user_id": testUserID, "accountable_user_id": testUserID, "status": "running", "dispatched_at": testutil.Raw("now()"), "started_at": testutil.Raw("now()"), "context": json.RawMessage(contextJSON)}
				if mode == "entry-retry" {
					cols["retry_of_task_id"] = taskID
				}
				actualID := dbfx.Task(t, uuidToString(task.AgentID), cols)
				actual, e := f.h.Queries.GetAgentTask(ctx, parseUUID(actualID))
				if e != nil {
					t.Fatal(e)
				}
				ctrl := parseUUID(uuid.NewString())
				if _, e = store.RecordController(ctx, actual, parseUUID(testWorkspaceID), ownership.ControllerRequest{Operation: "begin", ControllerID: ctrl, Provider: "codex", HostID: "continuation-fixture", PID: 44, Marker: "fixture-continuation"}); e != nil {
					t.Fatal(e)
				}
				yes := true
				if _, e = store.RecordController(ctx, actual, parseUUID(testWorkspaceID), ownership.ControllerRequest{Operation: "end", ControllerID: ctrl, HostID: "continuation-fixture", NoProviderStarted: &yes}); e != nil {
					t.Fatal(e)
				}
				dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", actualID)
				business.EntryTaskID = taskID
				business.ExecutionHintHash = hint.Hash
				business.TaskID = actualID
				business.AttemptID = actualID + ":" + strconv.FormatInt(actual.DispatchedAt.Time.UnixMicro(), 10)
				if mode == "continuation-missing-context" {
					dbfx.Exec(t, "UPDATE agent_task_queue SET context=NULL WHERE id=$1", actualID)
				}
				if mode == "continuation-wrong-hint" {
					business.ExecutionHintHash = strings.Repeat("9", 64)
				}
				if mode == "continuation-wrong-draft" {
					wrong := uuid.NewString()
					hint.DraftID = &wrong
					hint.Hash = hint.Digest()
					business.ExecutionHintHash = hint.Hash
					value, _ := json.Marshal(map[string]any{"engineering_recovery": hint})
					dbfx.Exec(t, "UPDATE agent_task_queue SET context=$2 WHERE id=$1", actualID, string(value))
				}
				validated, ve := f.h.engineeringRecoveryForTask(ctx, actual, testWorkspaceID)
				if mode == "direct-continuation" || mode == "continuation" || mode == "entry-retry" {
					if ve != nil || validated == nil || validated.Hash != hint.Hash {
						t.Fatal("native continuation could not bind", ve)
					}
				}
			}
			if mode == "direct-continuation" {
				business.Chain = "direct"
				business.Sequence = 0
				business.DraftID = nil
				business.DraftHash = nil
			}
			business.Hash = engineeringBusinessProgressHash(business)
			reads, records, closes := 0, 0, 0
			closed, stopped := false, false
			var saved json.RawMessage
			f.h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "handoff-context":
					if stopped {
						return nil, fmt.Errorf("management stopped")
					}
					return json.Marshal(current)
				case "handoff-observing":
					if closed {
						return json.RawMessage(`[]`), nil
					}
					return json.Marshal([]any{map[string]string{"case_id": "fixture-case"}})
				case "handoff-progress":
					records++
					next, e := json.Marshal(input["payload"])
					if e != nil {
						return nil, e
					}
					if saved != nil && !engineeringSameJSON(saved, json.RawMessage(next)) {
						return nil, fmt.Errorf("immutable progress replaced")
					}
					saved = next
					if mode == "stopped-after-record" {
						stopped = true
					}
					if mode == "new-fence" {
						if _, e := testPool.Exec(ctx, `INSERT INTO engineering_repair_fence(workspace_id,project_id,case_id,attempt_id,generation,owner_id,supervision_token,intent_revision,observation_id,issue_id,source_attempt_id,source_revision,snapshot_hash,workspace_path) VALUES($1,$2,'other-case','other-attempt',1,'other-owner',1,1,'other-original',$3,'other-source',1,'other-snapshot','/fixture')`, testWorkspaceID, f.project, f.issue); e != nil {
							t.Fatal(e)
						}
					}
					if mode == "new-reservation" {
						if _, e := f.h.Queries.CreateEngineeringRepairHandoffReservation(ctx, db.CreateEngineeringRepairHandoffReservationParams{TargetHash: strings.Repeat("9", 64), WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project), TaskID: parseUUID(uuid.NewString()), Payload: "{}"}); e != nil {
							t.Fatal(e)
						}
					}
					if mode == "progress-ack-retry" && records == 1 {
						return nil, fmt.Errorf("progress acknowledgement interrupted")
					}
					return next, nil
				case "handoff-close":
					closes++
					if saved == nil || !engineeringSameJSON(saved, input["payload"]) {
						return nil, fmt.Errorf("close did not reread saved progress")
					}
					closed = true
					if mode == "close-ack-lost" && closes == 1 {
						return nil, fmt.Errorf("closure acknowledgement lost")
					}
					return json.RawMessage(`{"closed":true}`), nil
				}
				return nil, fmt.Errorf("unexpected recovery management action %v", input["action"])
			}}
			f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				if input["action"] == "repair-recovery-checkpoint" {
					return json.RawMessage(`{"checkpoint":null,"reason":"waiting"}`), nil
				}
				if input["action"] != "repair-business-progress" {
					return nil, fmt.Errorf("observation attempted to change workflow %v", input["action"])
				}
				reads++
				if mode == "empty-result" || mode == "failed-no-result" {
					return json.RawMessage(`{"progress":null}`), nil
				}
				p := business
				if mode == "wrong-claim" {
					p.AttemptID = taskID + ":111"
				}
				if mode == "wrong-task" {
					p.TaskID = f.task
				}
				if mode == "missing-event" {
					p.CompletionEventHash = ""
				}
				if mode == "unapplied-result" {
					p.Applied = false
				}
				if mode == "changed-result" && reads > 1 {
					p.ResultHash = strings.Repeat("3", 64)
				}
				p.Hash = engineeringBusinessProgressHash(p)
				return json.Marshal(map[string]any{"progress": p})
			}}
			if mode == "later-work" {
				later := dbfx.Task(t, uuidToString(task.AgentID), testutil.Cols{"issue_id": f.issue, "runtime_id": uuidToString(task.RuntimeID), "status": "running", "dispatched_at": testutil.Raw("now()")})
				laterTask, e := f.h.Queries.GetAgentTask(ctx, parseUUID(later))
				if e != nil {
					t.Fatal(e)
				}
				if _, e = store.RecordController(ctx, laterTask, parseUUID(testWorkspaceID), ownership.ControllerRequest{Operation: "begin", ControllerID: parseUUID(uuid.NewString()), Provider: "codex", HostID: "later-fixture", PID: 43, Marker: "later-controller"}); e != nil {
					t.Fatal(e)
				}
			}
			root, err := os.MkdirTemp("", "recovery-progress-")
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
			err = f.h.ReconcileEngineeringRecoveryProgress(ctx, authority)
			if mode == "progress-ack-retry" || mode == "close-ack-lost" {
				if err == nil {
					t.Fatal("lost acknowledgement succeeded")
				}
				err = f.h.ReconcileEngineeringRecoveryProgress(ctx, authority)
			}
			success := mode == "direct-continuation" || mode == "continuation" || mode == "entry-retry" || mode == "failed-applied" || mode == "success" || mode == "progress-ack-retry" || mode == "close-ack-lost" || mode == "later-work"
			waiting := mode == "failed-no-result" || mode == "queued" || mode == "empty-result" || mode == "running" || mode == "cancelled" || mode == "missing-controller" || mode == "unfinished-controller"
			if (success || waiting) && err != nil {
				t.Fatal(err)
			}
			if !success && !waiting && err == nil {
				t.Fatal("invalid or stale observation succeeded")
			}
			if closed != success || success && closes != 1 {
				t.Fatal("Case closure did not reflect ordinary application and fresh cleanup", closed, closes, mode)
			}
			if mode == "failed-applied" {
				actual, e := f.h.Queries.GetAgentTask(ctx, parseUUID(taskID))
				if e != nil || actual.Status != "failed" {
					t.Fatal("business progress rewrote native process failure", e)
				}
				var proof engineeringRecoveryProgress
				if json.Unmarshal(saved, &proof) != nil || proof.Native.Status != "failed" {
					t.Fatal("recovery hid its native failure")
				}
			}
			if success && reads < 2 {
				t.Fatal("Case closed without a second business read")
			}
			if waiting && (closes != 0 || records != 0) {
				t.Fatal("pending recovery created closure evidence")
			}
			if mode == "progress-ack-retry" && records != 2 {
				t.Fatal("interrupted progress did not replay")
			}
			if saved != nil {
				var proof engineeringRecoveryProgress
				if json.Unmarshal(saved, &proof) != nil || proof.Business.AttemptID != business.AttemptID || engineeringNativeProgressHash(proof.Native) != proof.Native.Hash {
					t.Fatal("recorded progress lost native claim or immutable proof")
				}
			}
		})
	}
}

func TestEngineeringRecoveryHashMatchesKernel(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/command-chain/test-helpers/repair-business-progress.json")
	if err != nil {
		t.Fatal(err)
	}
	var value engineeringRecoveryProgress
	if err = json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	if engineeringBusinessProgressHash(value.Business) != value.Business.Hash || engineeringNativeProgressHash(value.Native) != value.Native.Hash {
		t.Fatal("native recovery digests differ from shared UTF-8 witnesses")
	}
	value.Business.Sequence++
	value.Native.AttemptID += "1"
	if engineeringBusinessProgressHash(value.Business) == value.Business.Hash || engineeringNativeProgressHash(value.Native) == value.Native.Hash {
		t.Fatal("recovery digest omitted the completed checkpoint or current native claim")
	}
}

func TestEngineeringRecoveryContinuationHashMatchesKernel(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/command-chain/test-helpers/repair-continuation-progress.json")
	if err != nil {
		t.Fatal(err)
	}
	var value engineeringRecoveryProgress
	if err = json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	if value.Business.EntryTaskID == value.Business.TaskID || value.Native.Status != "failed" || engineeringBusinessProgressHash(value.Business) != value.Business.Hash || engineeringNativeProgressHash(value.Native) != value.Native.Hash {
		t.Fatal("native and kernel continuation progress hashes differ")
	}
	value.Business.EntryTaskID = value.Business.TaskID
	if engineeringBusinessProgressHash(value.Business) == value.Business.Hash {
		t.Fatal("continuation lost its fixed entry identity")
	}
}
