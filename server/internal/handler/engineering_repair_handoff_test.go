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

// Management receipt compilation and real source hashing have their own tests.
// This layer exercises native PostgreSQL ownership and the private API boundary.
func TestEngineeringVerifiedHandoffPreparationRetainsNativeFence(t *testing.T) {
	for _, mode := range []string{"success", "changed-version", "changed-original", "new-writer", "stopped", "forged-reply", "ack-retry", "intent-changes", "foreign-human"} {
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
				t.Fatal("fixture not physically owned")
			}
			expected := "workspace-content-v1:" + strings.Repeat("a", 40) + ":" + strings.Repeat("b", 64)
			targetHash := strings.Repeat("c", 64)
			current := map[string]any{}
			for key, value := range f.current {
				current[key] = value
			}
			current["current_intent_revision"] = 1
			current["target_hash"] = targetHash
			current["target"] = map[string]any{"expectedVersion": expected, "workspaceBinding": map[string]string{"targetsHash": progress.TargetsHash}}
			task := mustControllerTask(t, f.controllerFixture)
			continuation := engineeringContinuation{WorkspaceID: testWorkspaceID, IssueID: f.issue, AgentID: uuidToString(task.AgentID), UserID: testUserID, TaskID: uuid.NewString(), ExpectedRevision: 1, ExpectedSequence: 8, Reason: "repair_ready"}
			prepared := map[string]any{"prepared": true, "hash": strings.Repeat("d", 64), "target_hash": targetHash, "kind": "yaml", "draft_id": uuid.NewString(), "continuation": continuation}
			writes, acknowledged := 0, 0
			f.h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "handoff-context":
					if mode == "stopped" {
						return nil, fmt.Errorf("management intent stopped")
					}
					return json.Marshal(current)
				case "handoff-prepared":
					acknowledged++
					if mode == "ack-retry" && acknowledged == 1 {
						return nil, fmt.Errorf("fixture acknowledgement interrupted")
					}
					return json.Marshal(input["payload"])
				case "handoff-pending":
					return json.Marshal([]any{map[string]string{"case_id": "fixture-case"}})
				}
				return nil, fmt.Errorf("unexpected handoff management action %v", input["action"])
			}}
			f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				switch input["action"] {
				case "repair-source":
					return json.Marshal(f.source)
				case "repair-handoff-prepare":
					writes++
					if mode == "intent-changes" {
						current["current_intent_revision"] = 2
					}
					if mode == "foreign-human" {
						changed := continuation
						changed.UserID = uuid.NewString()
						prepared["continuation"] = changed
					}
					if mode == "forged-reply" {
						prepared["target_hash"] = strings.Repeat("e", 64)
					}
					return json.Marshal(prepared)
				case "repair-workspace-version":
					version := expected
					if mode == "changed-version" {
						version = "changed"
					}
					return json.Marshal(map[string]string{"workspace_version": version})
				case "team-routing":
					return json.RawMessage(`{"binding":null}`), nil
				}
				return nil, fmt.Errorf("unexpected handoff business action %v", input["action"])
			}}
			if mode == "changed-original" {
				f.source["revision"] = 2
			}
			if mode == "new-writer" {
				dbfx.Task(t, uuidToString(task.AgentID), testutil.Cols{"runtime_id": uuidToString(task.RuntimeID), "issue_id": f.issue, "status": "queued"})
			}
			var before int
			if err = testPool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", f.issue).Scan(&before); err != nil {
				t.Fatal(err)
			}
			socketRoot, err := os.MkdirTemp("", "handoff-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(socketRoot)
			f.h.cfg.EngineeringDatabasePath = filepath.Join(socketRoot, "b.sqlite")
			if err = f.h.StartEngineeringLocalControl(ctx); err != nil {
				t.Fatal(err)
			}
			f.h.EngineeringTakeoverControl = &engineering.LocalControlClient{Socket: f.h.cfg.EngineeringDatabasePath + ".control.sock"}
			err = f.h.ReconcileEngineeringRepairHandoffs(ctx, engineeringAdminAuthority{OwnerID: "current-host", Token: 2})
			if mode == "ack-retry" {
				if err == nil {
					t.Fatal("interrupted acknowledgement unexpectedly succeeded")
				}
				err = f.h.ReconcileEngineeringRepairHandoffs(ctx, engineeringAdminAuthority{OwnerID: "current-host", Token: 2})
				if err != nil || writes != 2 || acknowledged != 2 {
					t.Fatal("handoff did not replay preparation after interrupted acknowledgement", err, writes, acknowledged)
				}
			} else if mode == "success" {
				if err != nil || writes != 1 || acknowledged != 1 {
					t.Fatal("native preparation did not acknowledge exact proof", err, writes, acknowledged)
				}
			} else if err == nil || acknowledged != 0 {
				t.Fatal("changed native handoff was accepted", mode, err)
			}
			fence, err := f.h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)})
			if err != nil || fence.CaseID != "fixture-case" {
				t.Fatal("preparation released the project fence", err)
			}
			var after int
			if err = testPool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", f.issue).Scan(&after); err != nil || after != before {
				t.Fatal("preparation enqueued or completed business work", err)
			}
		})
	}
}
