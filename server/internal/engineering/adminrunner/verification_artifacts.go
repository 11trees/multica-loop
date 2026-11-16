package adminrunner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

type verificationArtifact struct {
	Kind string `json:"kind"`
	Path string `json:"path"`
	Hash string `json:"hash"`
	Size int64  `json:"size"`
	Mode uint32 `json:"mode"`
}
type verificationArtifacts struct {
	Directory string                 `json:"directory"`
	Mode      uint32                 `json:"mode"`
	Hash      string                 `json:"hash"`
	Files     []verificationArtifact `json:"files"`
}

func readVerificationArtifacts(ctx context.Context, directory string) (verificationArtifacts, error) {
	var empty verificationArtifacts
	canonical, err := filepath.EvalSymlinks(directory)
	if err != nil || canonical != directory {
		return empty, fmt.Errorf("verification artifact directory changed")
	}
	scan := func() (verificationArtifacts, error) {
		result := verificationArtifacts{Directory: directory, Files: []verificationArtifact{}}
		root, err := os.Lstat(directory)
		if err != nil || !root.IsDir() || root.Mode()&os.ModeSymlink != 0 {
			return result, fmt.Errorf("verification artifact root is not a real directory")
		}
		result.Mode = uint32(root.Mode())
		var total int64
		err = filepath.WalkDir(directory, func(path string, entry fs.DirEntry, walkErr error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if walkErr != nil {
				return walkErr
			}
			if path == directory {
				return nil
			}
			if len(result.Files) >= 10000 {
				return fmt.Errorf("verification artifacts exceed 10000 entries")
			}
			before, err := os.Lstat(path)
			if err != nil {
				return err
			}
			if before.Mode()&os.ModeSymlink != 0 || (!before.IsDir() && (!before.Mode().IsRegular() || !verificationSingleLink(before))) {
				return fmt.Errorf("verification artifacts cannot contain links or special files")
			}
			relative, err := filepath.Rel(directory, path)
			if err != nil {
				return err
			}
			item := verificationArtifact{Path: filepath.ToSlash(relative), Mode: uint32(before.Mode()), Kind: "directory"}
			digest := sha256.New()
			if !before.IsDir() {
				item.Kind = "file"
				item.Size = before.Size()
				total += item.Size
				if total > 256<<20 {
					return fmt.Errorf("verification artifacts exceed 256 MiB")
				}
				file, err := os.Open(path)
				if err != nil {
					return err
				}
				opened, openErr := file.Stat()
				if openErr != nil || !os.SameFile(before, opened) {
					file.Close()
					return fmt.Errorf("verification artifact identity changed")
				}
				_, err = io.Copy(digest, file)
				file.Close()
				if err != nil {
					return err
				}
			}
			after, err := os.Lstat(path)
			if err != nil {
				return err
			}
			if !os.SameFile(before, after) || before.Mode() != after.Mode() || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
				return fmt.Errorf("verification artifact changed while reading")
			}
			item.Hash = hex.EncodeToString(digest.Sum(nil))
			result.Files = append(result.Files, item)
			return nil
		})
		if err != nil {
			return result, err
		}
		if err = ctx.Err(); err != nil {
			return result, err
		}
		hash := sha256.New()
		fmt.Fprintf(hash, "%d\n", result.Mode)
		for _, file := range result.Files {
			fmt.Fprintf(hash, "%s\x00%s\x00%s:%d:%d\n", file.Path, file.Kind, file.Hash, file.Size, file.Mode)
		}
		result.Hash = hex.EncodeToString(hash.Sum(nil))
		return result, nil
	}
	first, err := scan()
	if err != nil {
		return empty, err
	}
	second, err := scan()
	if err != nil {
		return empty, err
	}
	a, _ := json.Marshal(first)
	b, _ := json.Marshal(second)
	if string(a) != string(b) {
		return empty, fmt.Errorf("verification artifact set changed between scans")
	}
	return first, nil
}
