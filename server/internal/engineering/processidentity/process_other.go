//go:build !darwin && !linux

package processidentity

import (
	"context"
	"fmt"
)

func Supported() bool { return false }
func Marker(int) (string, error) {
	return "", fmt.Errorf("Process identity is not supported on this platform")
}
func GroupGone(int) bool                             { return false }
func StopRecorded(context.Context, int, string) bool { return false }
func ValidateGroup(int) error {
	return fmt.Errorf("Process identity is not supported on this platform")
}

func HostID() (string, error) {
	return "", fmt.Errorf("Native process host identity is not supported on this platform")
}
