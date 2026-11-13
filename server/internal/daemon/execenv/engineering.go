package execenv

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// EngineeringOverlay contains digests only: runtime file contents can contain credentials.
type EngineeringOverlay struct {
	Path string `json:"path"`
	Hash string `json:"hash"`
}

// EngineeringOverlays projects files created by Prepare and the injected brief.
// Business edits are never inferred from git status or added to this projection.
func EngineeringOverlays(env *Environment, provider string) ([]EngineeringOverlay, error) {
	data, err := os.ReadFile(filepath.Join(env.RootDir, sidecarManifestFile))
	if err != nil {
		return nil, err
	}
	var manifest sidecarManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, err
	}
	paths := append([]string{}, manifest.Files...)
	if path := runtimeConfigPath(env.WorkDir, provider); path != "" {
		paths = append(paths, path)
	}
	result := make([]EngineeringOverlay, 0, len(paths))
	seen := map[string]bool{}
	for _, path := range paths {
		if seen[path] {
			continue
		}
		seen[path] = true
		info, err := os.Lstat(path)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("engineering runtime file is not regular: %s", path)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		hash := sha256.Sum256(content)
		result = append(result, EngineeringOverlay{Path: path, Hash: hex.EncodeToString(hash[:])})
	}
	return result, nil
}
