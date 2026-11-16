package handler

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var builtinEngineeringTeams = []struct{ workflow, name string }{
	{"direct", "直接执行"},
	{"business_analysis", "业务分析"},
	{"end_to_end", "端到端交付"},
	{"develop", "开发交付"},
	{"bug_fix", "问题修复"},
}

func builtinEngineeringID(workspace, key string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("multica-loop:team:"+workspace+":"+key)).String()
}

func builtinEngineeringWorkflow(workspace, team string) string {
	if workspace != localWorkspaceID {
		return ""
	}
	for _, preset := range builtinEngineeringTeams {
		if team == builtinEngineeringID(workspace, preset.workflow) {
			return preset.workflow
		}
	}
	return ""
}

// Bootstrap only the reserved local workspace. Stable IDs distinguish built-ins
// from user-created Teams without matching editable names or resetting settings.
func (h *Handler) ensureLocalEngineeringTeams(ctx context.Context) error {
	if !h.cfg.LocalAuthEnabled || h.EngineeringWorker == nil {
		return nil
	}
	return h.ensureBuiltinEngineeringTeams(ctx, localWorkspaceID, localUserID)
}

func (h *Handler) ensureBuiltinEngineeringTeams(ctx context.Context, workspace, user string) error {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext('multica-loop:builtin-teams'))"); err != nil {
		return err
	}
	for _, preset := range builtinEngineeringTeams {
		team := builtinEngineeringID(workspace, preset.workflow)
		var existing string
		err := tx.QueryRow(ctx, "SELECT id::text FROM squad WHERE id=$1", team).Scan(&existing)
		if err == nil {
			continue
		}
		if err != pgx.ErrNoRows {
			return err
		}
		roles := engineeringTeamRoles[preset.workflow]
		for _, role := range roles {
			id := builtinEngineeringID(workspace, preset.workflow+":"+role)
			if _, err := tx.Exec(ctx, `INSERT INTO agent (id,workspace_id,name,runtime_mode,owner_id,visibility,permission_mode,instructions)
				VALUES ($1,$2,$3,'local',$4,'private','private',$5) ON CONFLICT (id) DO NOTHING`, id, workspace, preset.name+" · "+role, user,
				fmt.Sprintf("You are the %s role of the %s Team. Follow the task's frozen engineering workflow and authenticated role commands. Preserve independent verification and human decisions.", role, preset.workflow)); err != nil {
				return err
			}
		}
		leader := builtinEngineeringID(workspace, preset.workflow+":"+roles[0])
		if _, err := tx.Exec(ctx, `INSERT INTO squad (id,workspace_id,name,leader_id,creator_id) VALUES ($1,$2,$3,$4,$5)`, team, workspace, preset.name, leader, user); err != nil {
			return err
		}
		for index, role := range roles {
			membership := role
			if index == 0 {
				membership = "leader"
			}
			if _, err := tx.Exec(ctx, `INSERT INTO squad_member (squad_id,member_type,member_id,role) VALUES ($1,'agent',$2,$3)`, team, builtinEngineeringID(workspace, preset.workflow+":"+role), membership); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	// Native identity commits first. A failed private-worker write is retried
	// without duplicating Teams or overwriting an existing versioned definition.
	for _, preset := range builtinEngineeringTeams {
		team := builtinEngineeringID(workspace, preset.workflow)
		actor := map[string]string{"kind": "team-manager", "workspaceId": workspace, "teamId": team, "userId": user}
		result, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "team-profile", "actor": actor})
		if err != nil {
			return err
		}
		var state struct {
			Profile *json.RawMessage `json:"profile"`
		}
		if err := json.Unmarshal(result, &state); err != nil {
			return err
		}
		if state.Profile != nil {
			continue
		}
		roles := map[string]string{}
		for _, role := range engineeringTeamRoles[preset.workflow] {
			roles[role] = builtinEngineeringID(workspace, preset.workflow+":"+role)
		}
		_, err = h.EngineeringWorker.Call(ctx, map[string]any{"action": "team-profile", "actor": actor, "payload": map[string]any{"expected_revision": 0, "definition": map[string]any{"workflow": preset.workflow, "roles": roles, "decision_mode": "balanced", "max_reworks": 2}}})
		if err != nil {
			// Another bootstrap may have installed the first version after our read.
			current, readErr := h.EngineeringWorker.Call(ctx, map[string]any{"action": "team-profile", "actor": actor})
			if readErr != nil {
				return err
			}
			var saved struct {
				Profile *json.RawMessage `json:"profile"`
			}
			if json.Unmarshal(current, &saved) != nil || saved.Profile == nil {
				return err
			}
		}
	}
	return nil
}
