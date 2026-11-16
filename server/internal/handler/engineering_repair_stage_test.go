package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Business transaction integrity and management receipt validation have separate
// Node tests. This layer uses actual PostgreSQL and the private native socket.
func TestEngineeringReservedBusinessStaging(t *testing.T) {
	for _, mode := range []string{"success", "ack-retry", "missing-reservation", "corrupt-native-reservation", "changed-version", "changed-result", "changed-draft", "released-hold", "missing-lineage", "stopped", "stopped-after-stage", "new-terminal-writer", "existing-task"} {
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
			native := mustControllerTask(t, f.controllerFixture)
			item := engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: f.issue, AgentID: uuidToString(native.AgentID), UserID: testUserID, TaskID: uuid.NewString(), ExpectedRevision: 1, ExpectedSequence: 8, Reason: "repair_ready"}
			draftID := uuid.NewString()
			prepared := engineeringHandoffPreparation{Prepared: true, Hash: strings.Repeat("d", 64), TargetHash: strings.Repeat("c", 64), Continuation: item, Kind: "yaml", DraftID: &draftID}
			expected := "workspace-content-v1:" + strings.Repeat("a", 40) + ":" + strings.Repeat("b", 64)
			current := map[string]any{}
			for key, value := range f.current {
				current[key] = value
			}
			current["current_intent_revision"] = 1
			current["preparation"] = prepared
			current["target_hash"] = prepared.TargetHash
			current["target"] = map[string]any{"verificationAttemptId": "verified-native-checks", "expectedVersion": expected, "workspaceBinding": map[string]string{"targetsHash": progress.TargetsHash}}
			staged := false
			stageCalls, acks := 0, 0
			var reservation engineeringHandoffReservation
			var applied engineeringHandoffApplication
			f.h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "handoff-pending":
					return json.Marshal([]any{map[string]string{"case_id": "fixture-case"}})
				case "handoff-context":
					if mode == "stopped" && reservation.Reserved || mode == "stopped-after-stage" && staged {
						return nil, fmt.Errorf("management intent stopped")
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
					acks++
					if mode == "ack-retry" && acks == 1 {
						return nil, fmt.Errorf("fixture acknowledgement interrupted after business commit")
					}
					return json.Marshal(input["payload"])
				}
				return nil, fmt.Errorf("unexpected staging management action %v", input["action"])
			}}
			f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "repair-source":
					source := map[string]any{}
					for key, value := range f.source {
						source[key] = value
					}
					if staged && mode != "missing-lineage" {
						source["checkpoint_state"] = "staged"
						source["handoff_target_hash"] = prepared.TargetHash
						source["handoff_application_hash"] = applied.Hash
					}
					return json.Marshal(source)
				case "team-routing":
					return json.RawMessage(`{"binding":null}`), nil
				case "repair-handoff-prepare":
					return json.Marshal(prepared)
				case "repair-workspace-version":
					version := expected
					if staged && mode == "changed-version" {
						version = "changed"
					}
					return json.Marshal(map[string]string{"workspace_version": version})
				case "repair-handoff-stage":
					stageCalls++
					staged = true
					applied = engineeringHandoffApplication{Staged: true, HoldRetained: true, Hash: strings.Repeat("e", 64), TargetHash: reservation.TargetHash, PreparationHash: reservation.PreparationHash, ReservationHash: reservation.Hash, ExpectedVersion: reservation.ExpectedVersion, Continuation: item, DraftID: &draftID}
					if mode == "changed-result" {
						applied.ReservationHash = strings.Repeat("f", 64)
					}
					if mode == "changed-draft" {
						wrong := uuid.NewString()
						applied.DraftID = &wrong
					}
					if mode == "released-hold" {
						applied.HoldRetained = false
					}
					if mode == "new-terminal-writer" {
						dbfx.Task(t, uuidToString(native.AgentID), testutil.Cols{"runtime_id": uuidToString(native.RuntimeID), "issue_id": f.issue, "status": "cancelled", "dispatched_at": testutil.Raw("now()"), "completed_at": testutil.Raw("now()")})
					}
					return json.Marshal(applied)
				}
				return nil, fmt.Errorf("unexpected staging business action %v", input["action"])
			}}
			socketRoot, err := os.MkdirTemp("", "handoff-stage-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(socketRoot)
			f.h.cfg.EngineeringDatabasePath = filepath.Join(socketRoot, "b.sqlite")
			if err = f.h.StartEngineeringLocalControl(ctx); err != nil {
				t.Fatal(err)
			}
			f.h.EngineeringTakeoverControl = &engineering.LocalControlClient{Socket: f.h.cfg.EngineeringDatabasePath + ".control.sock"}
			call := func(action string) error {
				_, err := f.h.EngineeringTakeoverControl.Call(ctx, map[string]any{"action": action, "authority": engineeringAdminAuthority{OwnerID: "current-host", Token: 2}, "case_id": "fixture-case"})
				return err
			}
			if mode == "success" {
				if err = call("reserve-handoff"); err == nil {
					err = call("stage-handoff")
				}
			} else {
				if err = call("reserve-handoff"); err != nil {
					t.Fatal("fixture could not reserve successor", err)
				}
				if mode == "missing-reservation" {
					current["reservation"] = nil
				}
				if mode == "corrupt-native-reservation" {
					dbfx.Exec(t, "UPDATE engineering_repair_handoff SET payload='{}' WHERE project_id=$1", f.project)
				}
				if mode == "existing-task" {
					dbfx.Task(t, uuidToString(native.AgentID), testutil.Cols{"id": item.TaskID, "runtime_id": uuidToString(native.RuntimeID), "issue_id": f.issue, "status": "cancelled"})
				}
				err = call("stage-handoff")
			}
			if mode == "ack-retry" {
				if err == nil {
					t.Fatal("interrupted business acknowledgement succeeded")
				}
				first := applied.Hash
				current["current_intent_revision"] = 2
				err = call("stage-handoff")
				if stageCalls != 2 || acks != 2 || applied.Hash != first {
					t.Fatal("business staging did not replay the same successor")
				}
			}
			success := mode == "success" || mode == "ack-retry"
			if success && err != nil {
				t.Fatal(err)
			}
			if !success && (err == nil || acks != 0) {
				t.Fatal("changed staging was acknowledged", mode, err, acks)
			}
			fence, e := f.h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)})
			if e != nil || fence.Phase != "owned" {
				t.Fatal("business staging released native ownership", e)
			}
			saved, e := f.h.Queries.GetEngineeringRepairHandoff(ctx, prepared.TargetHash)
			if e != nil || saved.Phase != "reserved" {
				t.Fatal("business staging published or erased native reservation", e)
			}
			var count int
			if err = testPool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE id=$1", item.TaskID).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 0 && mode != "existing-task" {
				t.Fatal("business staging enqueued native work")
			}
		})
	}
}
