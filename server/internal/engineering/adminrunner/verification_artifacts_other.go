//go:build !darwin && !linux

package adminrunner

import "os"

func verificationSingleLink(os.FileInfo) bool { return false }
