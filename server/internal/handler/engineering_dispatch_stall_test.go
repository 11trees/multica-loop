package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// PostgreSQL and normal queue selection are real; SQLite and management proof
// compilation have their own canonical tests behind these host-only ports.
func TestEngineeringDispatchStallTakeback(t *testing.T) {
	for _, mode := range []string{"held", "stop-before-native", "retry-deferred", "unknown-controller", "not-due", "capacity-wait", "claim-raced", "hold-reply-lost", "observe-reply-lost", "ack-reply-lost", "stop-after-native"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			f := newRecoveryWatchFixture(t)
			f.h.EngineeringHostVersion = "sha256:" + strings.Repeat("c", 64)
			p := f.published.Publication
			original := mustControllerTask(t, f.controllerFixture)
			anchor := uuidToString(original.ID) + ":" + strconv.FormatInt(original.DispatchedAt.Time.UnixMicro(), 10)
			runtime, err := f.h.Queries.GetAgentRuntime(ctx, f.task.RuntimeID)
			if err != nil {
				t.Fatal(err)
			}
			if mode != "capacity-wait" {
				f.h.TaskService.EngineeringCapacity.Observe([]db.AgentRuntime{runtime}, 1, time.Now())
			}
			if mode == "retry-deferred" {
				dbfx.Task(t, p.AgentID, map[string]any{"issue_id": p.IssueID, "runtime_id": p.RuntimeID, "status": "deferred", "fire_at": time.Now().Add(time.Hour)})
			}
			if mode == "unknown-controller" {
				dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='preparing',no_provider_started=false WHERE task_id=$1", f.controllerFixture.task)
			}
			c := engineeringRecoveryCheckpoint{Hash: strings.Repeat("b", 64), CaseID: p.CaseID, VerificationAttemptID: p.VerificationAttemptID, TargetHash: p.TargetHash, ApplicationHash: p.ApplicationHash, ReadyHash: p.ReadyHash, EntryTaskID: p.TaskID, TaskID: p.TaskID, WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, AgentID: p.AgentID, UserID: p.UserID, RuntimeID: p.RuntimeID, ProjectID: f.project, DraftID: f.application.DraftID, Revision: 1, Sequence: 5, Preparation: &engineeringRecoveryPreparation{ObservationID: "retained-original", ReceiptHash: strings.Repeat("d", 64), SourceAttemptID: anchor, BindingsHash: strings.Repeat("e", 64)}}
			var sample engineeringReadinessObservation
			var held json.RawMessage
			var proof *engineeringDispatchStall
			holds, observations := 0, 0
			acked, stopped, lost := false, false, false
			f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "team-routing":
					return json.RawMessage(`{"owned":false,"binding":null,"profile":null}`), nil
				case "repair-dispatch-readiness":
					return json.Marshal(map[string]any{"workspaceId": p.WorkspaceID, "issueId": p.IssueID, "target_hash": p.TargetHash, "application_hash": p.ApplicationHash, "ready_hash": p.ReadyHash, "entry_task_id": p.TaskID, "agent_id": p.AgentID, "user_id": p.UserID, "hash": strings.Repeat("a", 64), "state": "eligible", "reason": "prepared-entry", "task_id": p.TaskID, "draft_id": f.application.DraftID, "revision": 1, "sequence": 5})
				case "repair-recovery-checkpoint":
					if held != nil {
						return json.Marshal(map[string]any{"held": held})
					}
					if mode == "claim-raced" {
						dbfx.Exec(t, "UPDATE agent_task_queue SET status='running',dispatched_at=now() WHERE id=$1", f.task.ID)
					}
					return json.Marshal(map[string]any{"checkpoint": c})
				case "repair-dispatch-hold":
					holds++
					native, _, e := f.h.dispatchStallTask(ctx, p)
					if e != nil {
						t.Fatal(e)
					}
					marker, e := engineeringDispatchMarker(native)
					if e != nil || marker == nil || native.DispatchedAt.Valid || native.StartedAt.Valid || native.Status != "queued" {
						t.Fatal("business hold preceded the durable native barrier", e)
					}
					proof = marker
					tasks, e := f.h.TaskService.ClaimTasksForRuntimes(ctx, []pgtype.UUID{runtime.ID}, 1)
					if e != nil || len(tasks) > 0 {
						t.Fatal("native queue claimed a logically held entry", e)
					}
					if mode == "stop-after-native" && !lost {
						lost = true
						stopped = true
						return nil, fmt.Errorf("stopped after durable reservation")
					}
					body, _ := json.Marshal(input["payload"])
					var value struct {
						Native engineeringDispatchStall `json:"native"`
					}
					if json.Unmarshal(body, &value) != nil || value.Native.Hash != marker.Hash || value.Native.Preparation.SourceAttemptID != anchor {
						t.Fatal("dispatch hold changed its actual source")
					}
					held, _ = json.Marshal(map[string]any{"workspaceId": p.WorkspaceID, "issueId": p.IssueID, "agentId": p.AgentID, "attemptId": anchor, "sourceKind": "prepared-dispatch", "chain": "verification", "observationId": "dispatch-stall:" + p.TargetHash, "summary": "Queue remained runnable without a native claim", "snapshotHash": strings.Repeat("3", 64), "requestHash": strings.Repeat("4", 64), "kernelVersion": "sha256:" + strings.Repeat("5", 64), "hostVersion": f.h.EngineeringHostVersion, "dispatchStall": marker})
					if mode == "hold-reply-lost" && !lost {
						lost = true
						return nil, fmt.Errorf("hold reply lost")
					}
					return json.Marshal(map[string]any{"held": held})
				case "repair-observations":
					if held == nil || acked {
						return json.RawMessage(`[]`), nil
					}
					return json.Marshal([]json.RawMessage{held})
				case "repair-observation-ack":
					if observations == 0 {
						t.Fatal("business acknowledged before management persisted")
					}
					if mode == "ack-reply-lost" && !lost {
						lost = true
						return nil, fmt.Errorf("acknowledgement lost")
					}
					acked = true
					return json.RawMessage(`{"acknowledged":true}`), nil
				}
				t.Fatalf("unexpected dispatch business action %v", input["action"])
				return nil, nil
			}}
			f.h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "handoff-context":
					if stopped {
						return nil, fmt.Errorf("management stopped")
					}
					return json.Marshal(f.management)
				case "handoff-watch":
					raw, _ := json.Marshal(input["payload"])
					if json.Unmarshal(raw, &sample) != nil {
						t.Fatal("missing actual readonly sample")
					}
					return json.Marshal(map[string]bool{"stall_due": mode != "not-due"})
				case "handoff-watch-read":
					if mode == "stop-before-native" {
						stopped = true
					}
					return json.Marshal(map[string]any{"stall_due": mode != "not-due", "observation": sample, "watch": map[string]any{"intentRevision": 1, "sourceKey": sample.SourceKey, "eligibleElapsedMs": 1200000}})
				case "observe":
					if held == nil {
						t.Fatal("management observed before business outbox")
					}
					observations++
					value, _ := json.Marshal(input["observation"])
					var event struct {
						CaseID string `json:"repairCaseId"`
					}
					if json.Unmarshal(value, &event) != nil || event.CaseID != p.CaseID {
						t.Fatal("dispatch hold escaped its original Case")
					}
					if mode == "observe-reply-lost" && !lost {
						lost = true
						return nil, fmt.Errorf("management reply lost")
					}
					return json.Marshal(map[string]string{"caseId": p.CaseID, "workspaceId": p.WorkspaceID, "scopeKey": p.WorkspaceID + ":" + p.IssueID + ":verification"})
				}
				t.Fatalf("unexpected dispatch management action %v", input["action"])
				return nil, nil
			}}
			request, _ := json.Marshal(engineeringPublicationRequest{Authority: engineeringAdminAuthority{OwnerID: "dispatch-host", Token: 2}, CaseID: p.CaseID})
			_, err = f.h.observeEngineeringRecoveryReadiness(ctx, request)
			interrupted := strings.HasSuffix(mode, "reply-lost") || mode == "stop-after-native"
			if interrupted {
				if err == nil {
					t.Fatal("interrupted handoff unexpectedly completed")
				}
				if mode == "stop-after-native" {
					if _, err = f.h.observeEngineeringRecoveryReadiness(ctx, request); err == nil {
						t.Fatal("stopped host advanced its durable intent")
					}
					stopped = false
					f.management["current_intent_revision"] = 2
				}
				_, err = f.h.observeEngineeringRecoveryReadiness(ctx, request)
			}
			if mode == "stop-before-native" {
				if err == nil {
					t.Fatal("stopped intent reserved native dispatch")
				}
				err = nil
			}
			if err != nil {
				t.Fatal(err)
			}
			success := mode != "stop-before-native" && mode != "retry-deferred" && mode != "unknown-controller" && mode != "not-due" && mode != "capacity-wait" && mode != "claim-raced"
			if acked != success || (observations > 0) != success {
				t.Fatal("dispatch takeback ignored eligibility or lost Case linkage", mode, acked, observations)
			}
			task, marker, e := f.h.dispatchStallTask(ctx, p)
			if e != nil {
				t.Fatal(e)
			}
			if success {
				if marker == nil || proof == nil || marker.Hash != proof.Hash || task.Status != "queued" || task.DispatchedAt.Valid || task.StartedAt.Valid {
					t.Fatal("takeback invented native execution or cancellation")
				}
				if holds > 2 {
					t.Fatal("outbox replay repeated the business hold")
				}
				source := engineeringTakeoverSource{CaseID: p.CaseID, WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, AgentID: p.AgentID, AttemptID: anchor, DispatchHoldHash: &marker.Hash, DispatchTaskID: &marker.TaskID}
				if e = f.h.validateEngineeringDispatchSource(ctx, source); e != nil {
					t.Fatal(e)
				}
				dbfx.Exec(t, "UPDATE engineering_repair_publication SET payload=jsonb_set(payload::jsonb,'{publication,published}','false'::jsonb)::text WHERE target_hash=$1", p.TargetHash)
				if e = f.h.validateEngineeringDispatchSource(ctx, source); e == nil {
					t.Fatal("unpublished native proof was accepted")
				}
				saved, _ := json.Marshal(f.published)
				dbfx.Exec(t, "UPDATE engineering_repair_publication SET payload=$2 WHERE target_hash=$1", p.TargetHash, string(saved))
				dbfx.Exec(t, "UPDATE agent_task_queue SET status='cancelled',completed_at=now() WHERE id=$1", task.ID)
				if e = f.h.validateEngineeringDispatchSource(ctx, source); e != nil {
					t.Fatal("normal later cancellation lost retained source", e)
				}
				dbfx.Exec(t, "UPDATE agent_task_queue SET context=context || '{\"changed\":true}'::jsonb WHERE id=$1", task.ID)
				if e = f.h.validateEngineeringDispatchSource(ctx, source); e == nil {
					t.Fatal("changed native source was accepted")
				}
			} else if marker != nil || holds != 0 {
				t.Fatal("ineligible work acquired a dispatch hold")
			}
			var fences int
			dbfx.QueryRow(t, "SELECT count(*) FROM engineering_repair_fence WHERE project_id=$1", f.project).Scan(&fences)
			if fences != 0 {
				t.Fatal("logical queue hold acquired repair write authority")
			}
		})
	}
}

func TestEngineeringDispatchStallHashMatchesKernel(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/command-chain/test-helpers/repair-dispatch-stall.json")
	if err != nil {
		t.Fatal(err)
	}
	var value engineeringDispatchStall
	if json.Unmarshal(raw, &value) != nil || engineeringDispatchStallHash(value) != value.Hash {
		t.Fatal("native and kernel dispatch hold witnesses differ")
	}
	value.Preparation.SourceAttemptID = "changed"
	if engineeringDispatchStallHash(value) == value.Hash {
		t.Fatal("dispatch hold lost retained binding provenance")
	}
}
