package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/engineering/ownership"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Native claims/queue/controllers/publications are real. Node tests own the
// checkpoint and immutable business outbox; management tests own Case storage.
func TestEngineeringRecoveryFault(t *testing.T) {
	for _, mode := range []string{"prebind-failed", "prebind-no-claim", "prebind-bound-claim", "failed", "completed-no-result", "unknown-exit", "continuation", "running", "cancelled", "human-wait", "answered-continuation", "retry-queued", "retry-deferred", "retry-running", "changed-claim", "changed-draft", "changed-sequence", "changed-context-hint", "stop-before-hold", "stop-after-hold", "hold-ack-lost", "observe-ack-lost", "business-ack-lost", "changed-held-case"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			f := newTakeoverControlFixture(t)
			original := mustControllerTask(t, f.controllerFixture)
			dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='quiesced',no_provider_started=true WHERE task_id=$1", f.task)
			dbfx.Exec(t, "UPDATE agent_task_queue SET status='cancelled',completed_at=now() WHERE id=$1", f.task)
			t.Cleanup(func() {
				dbfx.Exec(t, "DELETE FROM engineering_run_process WHERE controller_id IN (SELECT controller_id FROM engineering_run_guard WHERE project_id=$1)", f.project)
				dbfx.Exec(t, "DELETE FROM engineering_run_guard WHERE project_id=$1", f.project)
			})
			taskID := dbfx.Task(t, uuidToString(original.AgentID), testutil.Cols{"issue_id": f.issue, "runtime_id": uuidToString(original.RuntimeID), "originator_user_id": testUserID, "accountable_user_id": testUserID, "status": "running", "dispatched_at": testutil.Raw("now()"), "started_at": testutil.Raw("now()")})
			task, err := f.h.Queries.GetAgentTask(ctx, parseUUID(taskID))
			if err != nil {
				t.Fatal(err)
			}
			controller := parseUUID(uuid.NewString())
			ownershipStore := ownership.Store{Queries: f.h.Queries, Transactions: f.h.TxStarter}
			if _, err = ownershipStore.RecordController(ctx, task, parseUUID(testWorkspaceID), ownership.ControllerRequest{Operation: "begin", ControllerID: controller, Provider: "codex", HostID: "recovery-fault-fixture", PID: 42, Marker: "fixture-controller"}); err != nil {
				t.Fatal(err)
			}
			dbfx.Exec(t, "UPDATE agent_task_queue SET status='failed',completed_at=now(),failure_reason='fixture_recovery_failure' WHERE id=$1", taskID)
			item := engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: f.issue, AgentID: uuidToString(task.AgentID), UserID: testUserID, TaskID: taskID, ExpectedRevision: 1, ExpectedSequence: 5, Reason: "repair_ready"}
			target := strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")
			version := "workspace-content-v1:" + strings.Repeat("a", 40) + ":" + strings.Repeat("b", 64)
			reservation := engineeringHandoffReservation{Reserved: true, CaseID: "fixture-case", VerificationAttemptID: "verified-fault", TargetHash: target, PreparationHash: strings.Repeat("d", 64), ProjectID: f.project, ExpectedVersion: version, Continuation: item}
			reservation.Hash = engineeringHandoffReservationHash(reservation)
			payload, _ := json.Marshal(reservation)
			if _, err = f.h.Queries.CreateEngineeringRepairHandoffReservation(ctx, db.CreateEngineeringRepairHandoffReservationParams{TargetHash: target, WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project), TaskID: task.ID, Payload: string(payload)}); err != nil {
				t.Fatal(err)
			}
			dbfx.Exec(t, "UPDATE engineering_repair_handoff SET phase='published' WHERE target_hash=$1", target)
			draftID := uuid.NewString()
			application := engineeringHandoffApplication{Staged: true, HoldRetained: true, Hash: strings.Repeat("e", 64), TargetHash: target, PreparationHash: reservation.PreparationHash, ReservationHash: reservation.Hash, ExpectedVersion: version, Continuation: item, DraftID: &draftID}
			ready := engineeringHandoffReady{Ready: true, TargetHash: target, ReservationHash: reservation.Hash, ApplicationHash: application.Hash, ExpectedVersion: version, Continuation: item}
			ready.Hash = engineeringHandoffReadyHash(ready)
			publication := engineeringHandoffPublication{Published: true, CaseID: reservation.CaseID, VerificationAttemptID: reservation.VerificationAttemptID, TargetHash: target, ReservationHash: reservation.Hash, ApplicationHash: application.Hash, ReadyHash: ready.Hash, TaskID: taskID, WorkspaceID: testWorkspaceID, IssueID: f.issue, AgentID: item.AgentID, UserID: testUserID, RuntimeID: uuidToString(task.RuntimeID)}
			publication.Hash = engineeringHandoffPublicationHash(publication)
			published := engineeringHandoffPublished{Ready: ready, Publication: publication}
			payload, _ = json.Marshal(published)
			if _, err = f.h.Queries.CreateEngineeringRepairPublication(ctx, db.CreateEngineeringRepairPublicationParams{TargetHash: target, WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project), TaskID: task.ID, Payload: string(payload)}); err != nil {
				t.Fatal(err)
			}
			current := map[string]any{}
			for key, value := range f.current {
				current[key] = value
			}
			current["current_intent_revision"] = 1
			current["target_hash"] = target
			current["reservation"] = reservation
			current["application"] = application
			current["publication"] = published
			checkpoint := engineeringRecoveryCheckpoint{Hash: strings.Repeat("a", 64), CaseID: publication.CaseID, VerificationAttemptID: publication.VerificationAttemptID, TargetHash: target, ApplicationHash: application.Hash, ReadyHash: ready.Hash, EntryTaskID: taskID, TaskID: taskID, AttemptID: taskID + ":" + strconv.FormatInt(task.DispatchedAt.Time.UnixMicro(), 10), WorkspaceID: testWorkspaceID, IssueID: f.issue, AgentID: item.AgentID, UserID: testUserID, ProjectID: f.project, RuntimeID: publication.RuntimeID, DraftID: &draftID, Revision: 1, Sequence: 6}
			if strings.HasPrefix(mode, "prebind-") {
				checkpoint.Preparation = &engineeringRecoveryPreparation{ObservationID: "original-source", ReceiptHash: strings.Repeat("4", 64), SourceAttemptID: uuidToString(original.ID) + ":" + strconv.FormatInt(original.DispatchedAt.Time.UnixMicro(), 10), BindingsHash: strings.Repeat("5", 64)}
				checkpoint.AttemptID = ""
				if mode == "prebind-no-claim" {
					dbfx.Exec(t, "UPDATE agent_task_queue SET dispatched_at=NULL WHERE id=$1", taskID)
				}
				if mode == "prebind-bound-claim" {
					checkpoint.AttemptID = taskID + ":123"
				}
			}
			if mode == "continuation" || mode == "changed-context-hint" {
				hint := engineeringEntryRecoveryHint(ready, &draftID)
				hint.Kind = "continuation"
				hint.Sequence = 6
				hint.Hash = hint.Digest()
				contextJSON, _ := json.Marshal(map[string]any{"engineering_recovery": hint})
				child := dbfx.Task(t, item.AgentID, testutil.Cols{"issue_id": f.issue, "runtime_id": publication.RuntimeID, "originator_user_id": testUserID, "accountable_user_id": testUserID, "status": "failed", "dispatched_at": testutil.Raw("now()"), "completed_at": testutil.Raw("now()"), "context": json.RawMessage(contextJSON)})
				actual, e := f.h.Queries.GetAgentTask(ctx, parseUUID(child))
				if e != nil {
					t.Fatal(e)
				}
				checkpoint.TaskID = child
				checkpoint.AttemptID = child + ":" + strconv.FormatInt(actual.DispatchedAt.Time.UnixMicro(), 10)
				checkpoint.ExecutionHintHash = &hint.Hash
				if mode == "changed-context-hint" {
					wrong := strings.Repeat("9", 64)
					checkpoint.ExecutionHintHash = &wrong
				}
			}
			if mode == "answered-continuation" {
				checkpoint.AwaitingResume = true
			}
			if mode == "completed-no-result" {
				dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed' WHERE id=$1", taskID)
			}
			if mode == "running" {
				dbfx.Exec(t, "UPDATE agent_task_queue SET status='running',completed_at=NULL WHERE id=$1", taskID)
			}
			if mode == "cancelled" {
				dbfx.Exec(t, "UPDATE agent_task_queue SET status='cancelled' WHERE id=$1", taskID)
			}
			if strings.HasPrefix(mode, "retry-") {
				status := strings.TrimPrefix(mode, "retry-")
				dbfx.Task(t, item.AgentID, testutil.Cols{"issue_id": f.issue, "runtime_id": publication.RuntimeID, "status": status, "retry_of_task_id": taskID})
			}
			if mode == "changed-sequence" {
				checkpoint.Sequence = 4
			}
			if mode == "changed-claim" {
				checkpoint.AttemptID = taskID + ":123"
			}
			if mode == "changed-draft" {
				value := uuid.NewString()
				checkpoint.DraftID = &value
			}
			f.h.EngineeringHostVersion = "sha256:" + strings.Repeat("c", 64)
			held := json.RawMessage(nil)
			acked, recorded, stopped := false, false, false
			holds, deliveries, contexts := 0, 0, 0
			var event json.RawMessage
			lost := false
			f.h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "handoff-observing":
					if recorded {
						return json.RawMessage(`[]`), nil
					}
					return json.Marshal([]map[string]string{{"case_id": publication.CaseID}})
				case "handoff-context":
					contexts++
					if stopped || mode == "stop-before-hold" && contexts >= 4 {
						return nil, fmt.Errorf("management stopped")
					}
					return json.Marshal(current)
				case "observe":
					if held == nil {
						t.Fatal("management observed before the business hold")
					}
					deliveries++
					raw, _ := json.Marshal(input["observation"])
					if event != nil && !engineeringSameJSON(json.RawMessage(raw), event) {
						t.Fatal("outbox replay changed its observation")
					}
					event = raw
					var value struct {
						CaseID string `json:"repairCaseId"`
						Origin string `json:"origin"`
					}
					if json.Unmarshal(raw, &value) != nil || value.CaseID != publication.CaseID || value.Origin != "business" {
						t.Fatal("recovery fault escaped its original Case")
					}
					recorded = true
					if mode == "observe-ack-lost" && !lost {
						lost = true
						return nil, fmt.Errorf("observation acknowledgement lost")
					}
					return json.Marshal(map[string]string{"caseId": publication.CaseID, "workspaceId": testWorkspaceID, "scopeKey": testWorkspaceID + ":" + f.issue + ":verification"})
				default:
					t.Fatalf("unexpected recovery management action %v", input["action"])
					return nil, nil
				}
			}}
			f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "repair-business-progress":
					return json.RawMessage(`{"progress":null}`), nil
				case "repair-recovery-checkpoint":
					if held != nil {
						return json.Marshal(map[string]any{"checkpoint": nil, "held": held})
					}
					if mode == "human-wait" {
						return json.RawMessage(`{"checkpoint":null,"reason":"waiting-for-answers"}`), nil
					}
					return json.Marshal(map[string]any{"checkpoint": checkpoint})
				case "repair-recovery-hold":
					holds++
					raw, _ := json.Marshal(input["payload"])
					var body struct {
						Native engineeringRecoveryFault `json:"native"`
					}
					if json.Unmarshal(raw, &body) != nil || body.Native.Hash != engineeringRecoveryFaultHash(body.Native) || body.Native.CheckpointHash != checkpoint.Hash {
						t.Fatal("hold did not carry exact host-native evidence")
					}
					fault := body.Native
					if mode == "changed-held-case" {
						fault.CaseID = "another-case"
						fault.Hash = engineeringRecoveryFaultHash(fault)
					}
					held, _ = json.Marshal(map[string]any{"workspaceId": testWorkspaceID, "issueId": f.issue, "agentId": item.AgentID, "attemptId": fault.AttemptID, "chain": "verification", "observationId": "recovery-fault:" + target, "summary": "Native recovery failed without an applied result", "snapshotHash": strings.Repeat("b", 64), "requestHash": strings.Repeat("d", 64), "kernelVersion": "sha256:" + strings.Repeat("e", 64), "hostVersion": f.h.EngineeringHostVersion, "recovery": fault})
					if mode == "stop-after-hold" {
						stopped = true
					}
					if mode == "hold-ack-lost" && !lost {
						lost = true
						return nil, fmt.Errorf("business hold acknowledgement lost")
					}
					return json.Marshal(map[string]any{"held": held})
				case "repair-observations":
					if held == nil || acked {
						return json.RawMessage(`[]`), nil
					}
					return json.Marshal([]json.RawMessage{held})
				case "repair-observation-ack":
					if !recorded {
						t.Fatal("business acknowledged before management persistence")
					}
					if mode == "business-ack-lost" && !lost {
						lost = true
						return nil, fmt.Errorf("business acknowledgement interrupted")
					}
					acked = true
					return json.RawMessage(`{"acknowledged":true}`), nil
				default:
					t.Fatalf("unexpected recovery business action %v", input["action"])
					return nil, nil
				}
			}}
			authority := engineeringAdminAuthority{OwnerID: "fault-host", Token: 2}
			// The same implementation is reached through the private observe-handoff
			// socket in the progress tests. Call it directly here to isolate fault cases.
			request, _ := json.Marshal(engineeringPublicationRequest{Authority: authority, CaseID: publication.CaseID})
			_, err = f.h.observeEngineeringRepairHandoff(ctx, request)
			replay := mode == "hold-ack-lost" || mode == "observe-ack-lost" || mode == "business-ack-lost"
			if replay {
				if err == nil {
					t.Fatal("interrupted acknowledgement unexpectedly succeeded")
				}
				if mode == "hold-ack-lost" {
					_, err = f.h.observeEngineeringRepairHandoff(ctx, request)
				} else {
					err = f.h.ReconcileEngineeringAdmin(ctx, authority)
				}
			}
			refused := mode == "prebind-no-claim" || mode == "prebind-bound-claim" || mode == "changed-sequence" || mode == "changed-context-hint" || mode == "changed-claim" || mode == "changed-draft" || mode == "stop-before-hold" || mode == "changed-held-case"
			waiting := mode == "running" || mode == "cancelled" || mode == "human-wait" || mode == "answered-continuation" || strings.HasPrefix(mode, "retry-")
			if refused {
				if err == nil {
					t.Fatal("changed recovery source was accepted")
				}
			} else if err != nil {
				t.Fatal(err)
			}
			success := !refused && !waiting
			if recorded != success || acked != success {
				t.Fatal("recovery failure did not preserve/reopen its original Case", recorded, acked, mode)
			}
			expectedHolds := 0
			if success || mode == "changed-held-case" {
				expectedHolds = 1
			}
			if holds != expectedHolds {
				t.Fatal("recovery business hold repeated or ignored a legitimate wait", holds, mode)
			}
			if success && deliveries < 1 {
				t.Fatal("failure never reached management")
			}
			var fences int
			dbfx.QueryRow(t, "SELECT count(*) FROM engineering_repair_fence WHERE workspace_id=$1 AND project_id=$2", testWorkspaceID, f.project).Scan(&fences)
			if fences != 0 {
				t.Fatal("logical failure observation acquired write authority")
			}
			guard, e := f.h.Queries.GetEngineeringRunGuard(ctx, db.GetEngineeringRunGuardParams{ControllerID: controller, WorkspaceID: parseUUID(testWorkspaceID)})
			if e != nil || guard.Phase == "quiesced" {
				t.Fatal("failure observation invented physical cleanup", e)
			}
			actual, e := f.h.Queries.GetAgentTask(ctx, parseUUID(taskID))
			expectedStatus := "failed"
			if mode == "running" || mode == "cancelled" {
				expectedStatus = mode
			}
			if mode == "completed-no-result" {
				expectedStatus = "completed"
			}
			if e != nil || actual.Status != expectedStatus {
				t.Fatal("failure observation rewrote native status", e)
			}
		})
	}
}

func TestEngineeringRecoveryFaultHashMatchesKernel(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/command-chain/test-helpers/repair-recovery-fault.json")
	if err != nil {
		t.Fatal(err)
	}
	var fault engineeringRecoveryFault
	if err = json.Unmarshal(raw, &fault); err != nil {
		t.Fatal(err)
	}
	if engineeringRecoveryFaultHash(fault) != fault.Hash {
		t.Fatal("native and kernel fault hashes differ")
	}
	fault.CaseID = "another-case"
	if engineeringRecoveryFaultHash(fault) == fault.Hash {
		t.Fatal("fault lost its original Case")
	}
}

func TestEngineeringPrebindFaultHashMatchesKernel(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/command-chain/test-helpers/repair-prebind-fault.json")
	if err != nil {
		t.Fatal(err)
	}
	var value engineeringRecoveryFault
	if json.Unmarshal(raw, &value) != nil || value.Preparation == nil || engineeringRecoveryFaultHash(value) != value.Hash {
		t.Fatal("prepared fault provenance differs between native and kernel")
	}
	value.Preparation.SourceAttemptID = "changed-source"
	if engineeringRecoveryFaultHash(value) == value.Hash {
		t.Fatal("prepared fault lost retained source authority")
	}
}
