package handler

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestEngineeringBuiltinDevelopmentTeamPreservesIndependentRolesAndEdits(t *testing.T) {
	ctx := context.Background()
	h := *testHandler
	worker, err := filepath.Abs("../../../packages/command-chain/dist/worker.mjs")
	if err != nil {
		t.Fatal(err)
	}
	h.EngineeringWorker = &engineering.Client{Worker: worker, Database: filepath.Join(t.TempDir(), "teams.sqlite")}
	for _, preset := range builtinEngineeringTeams {
		id := builtinEngineeringID(testWorkspaceID, preset.workflow)
		dbfx.Cleanup(t, "DELETE FROM squad WHERE id=$1", id)
		dbfx.Cleanup(t, "DELETE FROM squad_member WHERE squad_id=$1", id)
		for _, role := range engineeringTeamRoles[preset.workflow] {
			dbfx.Cleanup(t, "DELETE FROM agent WHERE id=$1", builtinEngineeringID(testWorkspaceID, preset.workflow+":"+role))
		}
	}
	var wait sync.WaitGroup
	errors := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wait.Add(1)
		go func() { defer wait.Done(); errors <- h.ensureBuiltinEngineeringTeams(ctx, testWorkspaceID, testUserID) }()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	for workflow, roles := range engineeringTeamRoles {
		if workflow == "develop" {
			continue
		}
		if count := dbfx.Count(t, "SELECT count(*) FROM squad WHERE id=$1", builtinEngineeringID(testWorkspaceID, workflow)); count != 0 {
			t.Fatalf("bootstrap created a deferred Team: %s", workflow)
		}
		for _, role := range roles {
			if count := dbfx.Count(t, "SELECT count(*) FROM agent WHERE id=$1", builtinEngineeringID(testWorkspaceID, workflow+":"+role)); count != 0 {
				t.Fatalf("bootstrap created a deferred Team role: %s %s", workflow, role)
			}
		}
	}
	for _, preset := range builtinEngineeringTeams {
		id := builtinEngineeringID(testWorkspaceID, preset.workflow)
		team, err := h.Queries.GetSquadInWorkspace(ctx, db.GetSquadInWorkspaceParams{ID: parseUUID(id), WorkspaceID: parseUUID(testWorkspaceID)})
		if err != nil || team.Name != preset.name {
			t.Fatalf("built-in Team was not created: %s %v", preset.workflow, err)
		}
		members, err := h.Queries.ListSquadMembers(ctx, team.ID)
		if err != nil || len(members) != len(engineeringTeamRoles[preset.workflow]) {
			t.Fatalf("independent role members missing: %s %v", preset.workflow, err)
		}
		actor := map[string]string{"kind": "team-manager", "workspaceId": testWorkspaceID, "teamId": id, "userId": testUserID}
		data, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "team-profile", "actor": actor})
		if err != nil {
			t.Fatal(err)
		}
		var state struct {
			Profile engineeringTeamSnapshot `json:"profile"`
		}
		if err = json.Unmarshal(data, &state); err != nil {
			t.Fatal(err)
		}
		if state.Profile.Definition.Workflow != preset.workflow || state.Profile.Revision != 1 {
			t.Fatalf("workflow not predefined: %s", data)
		}
		for _, agentID := range state.Profile.Definition.Roles {
			if count := dbfx.Count(t, "SELECT count(*) FROM agent WHERE id=$1 AND workspace_id=$2 AND runtime_id IS NULL AND archived_at IS NULL", agentID, testWorkspaceID); count != 1 {
				t.Fatal("preset must create real unbound role Agents")
			}
		}
		if preset.workflow == "develop" {
			definition := state.Profile.Definition
			definition.MaxReworks = 4
			if _, err = h.EngineeringWorker.Call(ctx, map[string]any{"action": "team-profile", "actor": actor, "payload": map[string]any{"expected_revision": 1, "definition": definition}}); err != nil {
				t.Fatal(err)
			}
		}
	}
	id := builtinEngineeringID(testWorkspaceID, "develop")
	if _, err := testPool.Exec(ctx, "UPDATE squad SET name='My Team', archived_at=now() WHERE id=$1", id); err != nil {
		t.Fatal(err)
	}
	if err := h.ensureBuiltinEngineeringTeams(ctx, testWorkspaceID, testUserID); err != nil {
		t.Fatal(err)
	}
	if count := dbfx.Count(t, "SELECT count(*) FROM squad WHERE id=$1 AND name='My Team' AND archived_at IS NOT NULL", id); count != 1 {
		t.Fatal("bootstrap overwrote an edited or archived Team")
	}
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "team-profile", "actor": map[string]string{"kind": "team-manager", "workspaceId": testWorkspaceID, "teamId": id, "userId": testUserID}})
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		Profile struct {
			Revision   int                       `json:"revision"`
			Definition engineeringTeamDefinition `json:"definition"`
		} `json:"profile"`
	}
	if json.Unmarshal(data, &state) != nil || state.Profile.Revision != 2 || state.Profile.Definition.MaxReworks != 4 {
		t.Fatalf("bootstrap overwrote saved policy: %s", data)
	}
}
