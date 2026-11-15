//go:build darwin || linux

package adminrunner

import (
	"context"
	"errors"
	"fmt"
	"syscall"
	"time"
)

func supported() bool        { return true }
func groupGone(pid int) bool { return pid > 0 && errors.Is(syscall.Kill(-pid, 0), syscall.ESRCH) }
func stopRecorded(ctx context.Context, pid int, marker string) bool {
	if groupGone(pid) {
		return true
	}
	actual, err := processMarker(pid)
	if err != nil || actual != marker {
		return false
	}
	group, err := syscall.Getpgid(pid)
	if err != nil || group != pid {
		return false
	}
	if err = syscall.Kill(-pid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return false
	}
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if groupGone(pid) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
		case <-timer.C:
			actual, err = processMarker(pid)
			if err != nil || actual != marker {
				return false
			}
			if err = syscall.Kill(-pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
				return false
			}
			timer.Reset(time.Second)
		}
	}
}
func validateGroup(pid int) error {
	group, err := syscall.Getpgid(pid)
	if err != nil {
		return err
	}
	if group != pid {
		return fmt.Errorf("Admin provider is not its process-group leader")
	}
	return nil
}
