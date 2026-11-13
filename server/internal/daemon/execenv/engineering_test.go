package execenv

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestEngineeringPinnedWorktreeAndRuntimeProjection(t *testing.T) {
	repo := newTestRepo(t)
	commit := gitRun(t, repo, "rev-parse", "HEAD")
	writeFile(t, filepath.Join(repo, "tracked.txt"), "User edit outside the frozen contract\n")
	env, err := Prepare(PrepareParams{
		WorkspacesRoot: t.TempDir(), WorkspaceID: "engineering-workspace", TaskID: "11112222-3333-4444-5555-666677778888",
		AgentName: "Verifier", Provider: "claude", LocalWorktree: &LocalWorktreeParams{LocalPath: repo, PinnedCommit: commit},
		Task: TaskContextForEnv{IssueID: "engineering-issue", AgentID: "verifier", AgentName: "Verifier"},
	}, worktreeTestLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { env.LocalWorktree.Discard(worktreeTestLogger()) })
	if gitRun(t, env.WorkDir, "rev-parse", "HEAD") != commit {
		t.Fatal("worktree did not use frozen commit")
	}
	if gitRun(t, env.WorkDir, "show", "HEAD:tracked.txt") != gitRun(t, repo, "show", commit+":tracked.txt") {
		t.Fatal("worktree did not retain frozen source")
	}
	if content, _ := os.ReadFile(filepath.Join(env.WorkDir, "tracked.txt")); string(content) == "User edit outside the frozen contract\n" {
		t.Fatal("pinned worktree replayed user edits")
	}
	if _, err := InjectRuntimeConfig(env.WorkDir, "claude", TaskContextForEnv{IssueID: "engineering-issue"}); err != nil {
		t.Fatal(err)
	}
	overlays, err := EngineeringOverlays(env, "claude")
	if err != nil || len(overlays) == 0 {
		t.Fatalf("missing runtime projection: %v", err)
	}
	foundBrief, foundMarker := false, false
	for _, item := range overlays {
		content, err := os.ReadFile(item.Path)
		if err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256(content)
		if item.Hash != hex.EncodeToString(hash[:]) {
			t.Fatal("runtime projection did not capture current bytes")
		}
		if item.Path == filepath.Join(env.WorkDir, "CLAUDE.md") {
			foundBrief = true
		}
		if item.Path == filepath.Join(env.WorkDir, TaskContextMarkerRelPath) {
			foundMarker = true
		}
		if filepath.Base(item.Path) == "tracked.txt" {
			t.Fatal("business code entered runtime projection")
		}
	}
	if !foundBrief || !foundMarker {
		t.Fatal("runtime projection omitted brief or task marker")
	}
	if err := CleanupRuntimeConfig(env.WorkDir, "claude"); err != nil {
		t.Fatal(err)
	}
	if err := CleanupSidecars(env.RootDir); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(env.LocalWorktree)
	var worktree LocalWorktree
	if err := json.Unmarshal(data, &worktree); err != nil {
		t.Fatal(err)
	}
	outcome, err := worktree.Finalize(worktreeTestLogger())
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Branch == "" || gitRun(t, repo, "rev-parse", "refs/heads/"+outcome.Branch) != commit {
		t.Fatal("unchanged pinned delivery branch was lost")
	}
	if _, err := os.Stat(env.WorkDir); !os.IsNotExist(err) {
		t.Fatal("finalized worktree was not reclaimed")
	}
}

func TestEngineeringPinnedWorktreeRejectsUnresolvedCommit(t *testing.T) {
	repo := newTestRepo(t)
	for _, commit := range []string{"HEAD", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"} {
		_, err := PrepareLocalWorktree(LocalWorktreeParams{LocalPath: repo, EnvRoot: t.TempDir(), TaskID: "11112222-3333-4444-5555-666677778888", PinnedCommit: commit}, worktreeTestLogger())
		if err == nil {
			t.Fatalf("accepted unavailable or symbolic commit %q", commit)
		}
	}
}
