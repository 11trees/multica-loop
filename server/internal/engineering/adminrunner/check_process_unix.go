//go:build darwin || linux

package adminrunner

import (
	"context"
	"github.com/multica-ai/multica/server/internal/engineering/processidentity"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func nativeChecksSupported() bool { return true }
func nativeWorkerCommand(binary string) *exec.Cmd {
	command := exec.Command(binary, "engineering", "verification-worker")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return command
}
func onlyNativeWorker(ctx context.Context, pid int, marker string) bool {
	actual, err := processidentity.Marker(pid)
	if err != nil || actual != marker || processidentity.ValidateGroup(pid) != nil {
		return false
	}
	command := exec.CommandContext(ctx, "ps", "-e", "-o", "pid=,pgid=")
	out, err := command.Output()
	if err != nil {
		return false
	}
	seen := false
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		process, e1 := strconv.Atoi(fields[0])
		group, e2 := strconv.Atoi(fields[1])
		if e1 != nil || e2 != nil {
			return false
		}
		if group == pid {
			if process != pid {
				return false
			}
			seen = true
		}
	}
	actual, err = processidentity.Marker(pid)
	return err == nil && actual == marker && seen
}
