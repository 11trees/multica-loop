package handler

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/engineering/processidentity"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func physicalTakeoverFixture(t *testing.T) takeoverControlFixture {
	t.Helper()
	host, err := processidentity.HostID()
	if err != nil {
		t.Skip("local physical identity unavailable")
	}
	f := newTakeoverControlFixture(t)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	resource, _ := json.Marshal(map[string]string{"local_path": root, "daemon_id": "takeover-control-fixture", "execution_mode": "in_place"})
	dbfx.Exec(t, "UPDATE project_resource SET resource_ref=$1 WHERE project_id=$2", resource, f.project)
	f.source["registered_repository_path"] = root
	f.source["execution_repository_path"] = root
	inspection := f.current["request"].(map[string]any)["inspection"].(map[string]any)
	inspection["registered_repository_path"] = root
	inspection["execution_repository_path"] = root
	marker, err := processidentity.Marker(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	dbfx.Exec(t, "UPDATE engineering_run_guard SET workspace_path=$1,execution_mode='in_place',host_id=$2,controller_pid=$3,controller_marker=$4 WHERE controller_id=$5", root, host, os.Getpid(), marker, f.controller)
	return f
}
func TestEngineeringPhysicalRequiresFinalControllerCleanup(t *testing.T) {
	ctx := context.Background()
	f := physicalTakeoverFixture(t)
	result, err := f.h.DrainEngineeringProject(ctx, f.body)
	if err != nil {
		t.Fatal(err)
	}
	if result.(engineeringRepairProgress).Phase != "draining" || result.(engineeringRepairProgress).WorkspaceRoot != nil {
		t.Fatal("missing cleanup granted ownership", result)
	}
	dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='quiesced',no_provider_started=true WHERE controller_id=$1", f.controller)
	result, err = f.h.DrainEngineeringProject(ctx, f.body)
	if err != nil {
		t.Fatal(err)
	}
	progress := result.(engineeringRepairProgress)
	if progress.Phase != "owned" || progress.WorkspaceRoot == nil || progress.UnknownTasks != 0 || progress.UnfinishedControllers != 0 {
		t.Fatalf("known no-spawn final cleanup not owned: %+v", progress)
	}
	if _, err = f.h.DrainEngineeringProject(ctx, f.body); err != nil {
		t.Fatal("owned receipt not replayable", err)
	}
	fence, err := f.h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)})
	if err != nil || fence.Phase != "owned" {
		t.Fatal("ownership not persisted", err)
	}
	var targets engineeringRepairTargets
	if err = json.Unmarshal(fence.Targets, &targets); err != nil || len(targets.Tasks) != 1 || len(targets.Controllers) != 1 {
		t.Fatal("missing durable target inventory", err)
	}
}
func TestEngineeringPhysicalRetainsLegacyTerminalWritersAcrossReassociation(t *testing.T) {
	ctx := context.Background()
	f := physicalTakeoverFixture(t)
	native := mustControllerTask(t, f.controllerFixture)
	dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='quiesced',no_provider_started=true WHERE controller_id=$1", f.controller)
	legacy := dbfx.Task(t, uuidToString(native.AgentID), testutil.Cols{"runtime_id": uuidToString(native.RuntimeID), "issue_id": f.issue, "status": "cancelled", "dispatched_at": testutil.Raw("now()"), "completed_at": testutil.Raw("now()")})
	result, err := f.h.DrainEngineeringProject(ctx, f.body)
	if err != nil {
		t.Fatal(err)
	}
	if result.(engineeringRepairProgress).Phase != "draining" || result.(engineeringRepairProgress).UnknownTasks != 1 {
		t.Fatal("legacy terminal writer disappeared", result)
	}
	other := dbfx.Issue(t, "Reassociated legacy writer")
	dbfx.Exec(t, "UPDATE agent_task_queue SET issue_id=$1 WHERE id=$2", other, legacy)
	result, err = f.h.DrainEngineeringProject(ctx, f.body)
	if err != nil {
		t.Fatal(err)
	}
	if result.(engineeringRepairProgress).Phase != "draining" || result.(engineeringRepairProgress).UnknownTasks != 1 {
		t.Fatal("reassociation erased durable physical target", result)
	}
}
func TestEngineeringPhysicalCanReconcileExplicitNoSpawnFinalReceipt(t *testing.T) {
	ctx := context.Background()
	f := physicalTakeoverFixture(t)
	dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='unconfirmed',no_provider_started=true WHERE controller_id=$1", f.controller)
	dbfx.Exec(t, "INSERT INTO engineering_run_process(allocation_id,controller_id,workspace_id) VALUES(gen_random_uuid(),$1,$2)", f.controller, testWorkspaceID)
	result, err := f.h.DrainEngineeringProject(ctx, f.body)
	if err != nil {
		t.Fatal(err)
	}
	if result.(engineeringRepairProgress).Phase != "owned" {
		t.Fatal("known no-spawn receipt was not reconciled", result)
	}
	processes, err := f.h.Queries.ListEngineeringRunProcesses(ctx, db.ListEngineeringRunProcessesParams{WorkspaceID: parseUUID(testWorkspaceID), ControllerID: parseUUID(f.controller)})
	if err != nil || len(processes) != 1 || processes[0].Phase != "exited" || processes[0].ExitPid.Int64 != 0 {
		t.Fatal("no-spawn proof not persisted", err)
	}
}

func TestEngineeringPhysicalUnknownLaunchCannotBecomeOwned(t *testing.T) {
	f := physicalTakeoverFixture(t)
	dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='unconfirmed',no_provider_started=false WHERE controller_id=$1", f.controller)
	dbfx.Exec(t, "INSERT INTO engineering_run_process(allocation_id,controller_id,workspace_id) VALUES(gen_random_uuid(),$1,$2)", f.controller, testWorkspaceID)
	result, err := f.h.DrainEngineeringProject(context.Background(), f.body)
	if err != nil {
		t.Fatal(err)
	}
	progress := result.(engineeringRepairProgress)
	if progress.Phase != "draining" || progress.UnfinishedControllers != 1 || progress.WorkspaceRoot != nil {
		t.Fatalf("missing physical identity became owned: %+v", progress)
	}
}

func TestEngineeringPhysicalZeroPIDReceiptCannotProveStartedProviderExited(t *testing.T) {
	for _, phase := range []string{"unconfirmed", "quiesced"} {
		t.Run(phase, func(t *testing.T) {
			f := physicalTakeoverFixture(t)
			dbfx.Exec(t, "UPDATE engineering_run_guard SET phase=$1,no_provider_started=false WHERE controller_id=$2", phase, f.controller)
			dbfx.Exec(t, "INSERT INTO engineering_run_process(allocation_id,controller_id,workspace_id,phase,exit_pid) VALUES(gen_random_uuid(),$1,$2,'exited',0)", f.controller, testWorkspaceID)
			result, err := f.h.DrainEngineeringProject(context.Background(), f.body)
			if err != nil {
				t.Fatal(err)
			}
			progress := result.(engineeringRepairProgress)
			if progress.Phase != "draining" || progress.UnfinishedControllers != 1 || progress.WorkspaceRoot != nil {
				t.Fatalf("Zero-PID no-spawn receipt established physical ownership: %+v", progress)
			}
		})
	}
}

func TestEngineeringPhysicalUsesRegisteredRootAfterExecutionWorktreeCleanup(t *testing.T) {
	f := physicalTakeoverFixture(t)
	root := f.source["registered_repository_path"].(string)
	execution := filepath.Join(t.TempDir(), "finished-worktree")
	if err := os.Mkdir(execution, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(execution); err != nil {
		t.Fatal(err)
	}
	resource, _ := json.Marshal(map[string]string{"local_path": root, "daemon_id": "takeover-control-fixture", "execution_mode": "worktree"})
	dbfx.Exec(t, "UPDATE project_resource SET resource_ref=$1 WHERE project_id=$2", resource, f.project)
	f.source["execution_repository_path"], f.source["mode"] = execution, "worktree"
	inspection := f.current["request"].(map[string]any)["inspection"].(map[string]any)
	inspection["execution_repository_path"], inspection["mode"] = execution, "worktree"
	dbfx.Exec(t, "UPDATE engineering_run_guard SET workspace_path=$1,execution_mode='worktree',phase='quiesced',no_provider_started=true WHERE controller_id=$2", execution, f.controller)
	result, err := f.h.DrainEngineeringProject(context.Background(), f.body)
	if err != nil {
		t.Fatal(err)
	}
	progress := result.(engineeringRepairProgress)
	if progress.Phase != "owned" || progress.WorkspaceRoot == nil || *progress.WorkspaceRoot != root {
		t.Fatalf("Cleanup lost the registered repair anchor: %+v", progress)
	}
	if _, err = os.Stat(execution); !os.IsNotExist(err) {
		t.Fatal("Takeover recreated the cleaned execution worktree", err)
	}
}

func TestEngineeringPhysicalMissingRegisteredRootKeepsFenceWithoutRecreatingDirectory(t *testing.T) {
	f := physicalTakeoverFixture(t)
	root := f.source["registered_repository_path"].(string)
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='quiesced',no_provider_started=true WHERE controller_id=$1", f.controller)
	result, err := f.h.DrainEngineeringProject(context.Background(), f.body)
	if err != nil {
		t.Fatal(err)
	}
	progress := result.(engineeringRepairProgress)
	if progress.Phase != "draining" || progress.WorkspaceRoot != nil {
		t.Fatalf("A missing registered root became owned: %+v", progress)
	}
	if _, err = os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("Takeover recreated the missing project directory", err)
	}
	fence, err := f.h.Queries.GetEngineeringRepairFence(context.Background(), db.GetEngineeringRepairFenceParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)})
	if err != nil || fence.Phase != "draining" {
		t.Fatal("Missing root released the project fence", err)
	}
}
