//go:build !darwin && !linux

package adminrunner

import (
	"context"
	"fmt"
)

func supported() bool { return false }
func processMarker(int) (string, error) {
	return "", fmt.Errorf("Admin process identity is not supported on this platform")
}
func groupGone(int) bool                             { return false }
func stopRecorded(context.Context, int, string) bool { return false }
func validateGroup(int) error {
	return fmt.Errorf("Admin process identity is not supported on this platform")
}
