//go:build darwin || linux

package processidentity

import (
	"context"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

func TestAdminRecordedProcessStopRequiresExactBirthIdentity(t *testing.T) {
	cmd := exec.Command("/bin/sleep", "30")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-done })
	marker, err := Marker(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if StopRecorded(ctx, cmd.Process.Pid, marker+"-wrong") {
		t.Fatal("Wrong birth marker confirmed or stopped a process")
	}
	if err = syscall.Kill(cmd.Process.Pid, 0); err != nil {
		t.Fatal("Wrong birth marker signalled the owned fixture")
	}
	if !StopRecorded(ctx, cmd.Process.Pid, marker) || !GroupGone(cmd.Process.Pid) {
		t.Fatal("Exact fixture identity did not confirm physical exit")
	}
}
