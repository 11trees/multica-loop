//go:build darwin || linux

package handler

import (
	"context"
	"os/exec"
	"syscall"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/engineering/processidentity"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func physicalProviderFixture(t *testing.T, markerSuffix string, foreign bool) (takeoverControlFixture, *exec.Cmd, <-chan struct{}) {
	t.Helper()
	f := physicalTakeoverFixture(t)
	command := exec.Command("/bin/sleep", "30")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = command.Wait(); close(done) }()
	t.Cleanup(func() { _ = command.Process.Kill(); <-done })
	marker, err := processidentity.Marker(command.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	dbfx.Exec(t, "UPDATE engineering_run_guard SET phase='unconfirmed',no_provider_started=false WHERE controller_id=$1", f.controller)
	if foreign {
		dbfx.Exec(t, "UPDATE engineering_run_guard SET host_id='other-host-boot' WHERE controller_id=$1", f.controller)
	}
	dbfx.Exec(t, "INSERT INTO engineering_run_process(allocation_id,controller_id,workspace_id,phase,pid,marker,group_id) VALUES($1,$2,$3,'running',$4,$5,$4)", uuid.NewString(), f.controller, testWorkspaceID, command.Process.Pid, marker+markerSuffix)
	return f, command, done
}
func TestEngineeringPhysicalStopsOnlyRecordedProviderGroupAndReconcilesCleanup(t *testing.T) {
	ctx := context.Background()
	f, command, done := physicalProviderFixture(t, "", false)
	result, err := f.h.DrainEngineeringProject(ctx, f.body)
	if err != nil {
		t.Fatal(err)
	}
	if result.(engineeringRepairProgress).Phase != "owned" || !processidentity.GroupGone(command.Process.Pid) {
		t.Fatalf("recorded provider did not drain: %+v", result)
	}
	<-done
	guard, err := f.h.Queries.GetEngineeringRunGuard(ctx, db.GetEngineeringRunGuardParams{WorkspaceID: parseUUID(testWorkspaceID), ControllerID: parseUUID(f.controller)})
	if err != nil || guard.Phase != "quiesced" {
		t.Fatal("final cleanup receipt not reconciled", err)
	}
	processes, err := f.h.Queries.ListEngineeringRunProcesses(ctx, db.ListEngineeringRunProcessesParams{WorkspaceID: guard.WorkspaceID, ControllerID: guard.ControllerID})
	if err != nil || len(processes) != 1 || processes[0].Phase != "exited" || processes[0].ExitPid.Int64 != int64(command.Process.Pid) {
		t.Fatal("physical exit identity lost", err)
	}
}
func TestEngineeringPhysicalRejectsForeignHostAndWrongBirthMarker(t *testing.T) {
	for _, foreign := range []bool{false, true} {
		name := "wrong-marker"
		suffix := "-wrong"
		if foreign {
			name = "foreign-host"
			suffix = ""
		}
		t.Run(name, func(t *testing.T) {
			f, command, _ := physicalProviderFixture(t, suffix, foreign)
			result, err := f.h.DrainEngineeringProject(context.Background(), f.body)
			if err != nil {
				t.Fatal(err)
			}
			if result.(engineeringRepairProgress).Phase != "draining" || result.(engineeringRepairProgress).WorkspaceRoot != nil {
				t.Fatal("unproven writer granted ownership", result)
			}
			if err = syscall.Kill(command.Process.Pid, 0); err != nil {
				t.Fatal("unmatched process was signalled", err)
			}
		})
	}
}
func TestEngineeringPhysicalWillNotSignalSharedControllerPID(t *testing.T) {
	f, command, _ := physicalProviderFixture(t, "", false)
	// Presenting the shared controller as a provider must not authorize a signal.
	dbfx.Exec(t, "UPDATE engineering_run_guard SET controller_pid=$1 WHERE controller_id=$2", command.Process.Pid, f.controller)
	result, err := f.h.DrainEngineeringProject(context.Background(), f.body)
	if err != nil {
		t.Fatal(err)
	}
	if result.(engineeringRepairProgress).Phase != "draining" {
		t.Fatal("shared-controller identity was treated as a drained child", result)
	}
	if err = syscall.Kill(command.Process.Pid, 0); err != nil {
		t.Fatal("shared controller was signalled", err)
	}
}
