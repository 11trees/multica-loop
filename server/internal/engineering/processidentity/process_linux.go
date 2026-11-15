//go:build linux

package processidentity

import (
	"fmt"
	"os"
	"strings"
)

func Marker(pid int) (string, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", err
	}
	parts := strings.Fields(string(data)[strings.LastIndex(string(data), ")")+1:])
	if len(parts) <= 19 {
		return "", fmt.Errorf("incomplete process identity")
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(boot)) + ":" + parts[19], nil
}

func HostID() (string, error) {
	data, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	return strings.TrimSpace(string(data)), err
}
