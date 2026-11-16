//go:build !darwin && !linux

package adminrunner

import (
	"context"
	"os/exec"
)

func nativeChecksSupported() bool { return false }
func nativeWorkerCommand(binary string) *exec.Cmd {
	return exec.Command(binary, "engineering", "verification-worker")
}
func onlyNativeWorker(context.Context, int, string) bool { return false }
