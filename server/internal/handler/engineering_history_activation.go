package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type historyActivationWorkspace struct {
	ProjectID string `json:"project_id"`
	Root      string `json:"root"`
	Head      string `json:"head"`
	Dirty     bool   `json:"dirty"`
	Symlinks  int    `json:"symlinks"`
}
type historyActivationReceipt struct {
	Format           string                      `json:"format"`
	CutoverID        string                      `json:"cutover_id"`
	ScopeHash        string                      `json:"scope_hash"`
	WorkspaceHash    string                      `json:"workspace_hash"`
	ActivatedBy      string                      `json:"activated_by"`
	ActivatedAt      string                      `json:"activated_at"`
	ExecutionMode    string                      `json:"execution_mode"`
	SourceInspection json.RawMessage             `json:"source_inspection"`
	Tasks            []map[string]any            `json:"tasks"`
	Resources        []historyActivationResource `json:"resources"`
	Roles            []historyActivationRole     `json:"roles"`
	ExecutionStarted bool                        `json:"execution_started"`
}
type historyActivationResource struct {
	ID        string          `json:"id"`
	ProjectID string          `json:"project_id"`
	Ref       json.RawMessage `json:"resource_ref"`
}
type historyActivationRole struct {
	AgentID   string `json:"agent_id"`
	RuntimeID string `json:"runtime_id"`
	DaemonID  string `json:"daemon_id"`
}

func (h *Handler) inspectHistoryWorkspaces(ctx context.Context, row db.EngineeringHistoryCutover, expected string) (json.RawMessage, []historyActivationWorkspace, error) {
	var receipt struct {
		Observations []struct {
			Hash    string          `json:"hash"`
			Payload json.RawMessage `json:"payload"`
		} `json:"workspace_observations"`
	}
	if json.Unmarshal(row.Receipt, &receipt) != nil || len(receipt.Observations) == 0 {
		return nil, nil, historyConflict("record the current workspace baseline before activation")
	}
	latest := receipt.Observations[len(receipt.Observations)-1]
	if latest.Hash != expected || h.EngineeringSourceInspector == nil {
		return nil, nil, historyConflict("activate only the explicitly reviewed latest workspace baseline")
	}
	raw, err := h.EngineeringSourceInspector.Call(ctx, map[string]any{"action": "workspace-check", "expected_hash": row.ArchiveHash, "expected_workspace_hash": expected, "workspace_observation": latest, "record": map[string]any{"id": uuidToString(row.ID), "archive_hash": row.ArchiveHash, "scope_hash": row.ScopeHash, "source_namespace": row.SourceNamespace, "payload": json.RawMessage(row.Payload)}})
	if err != nil {
		return nil, nil, err
	}
	var result struct {
		Format        string                       `json:"format"`
		CutoverID     string                       `json:"cutover_id"`
		ArchiveHash   string                       `json:"archive_hash"`
		ScopeHash     string                       `json:"scope_hash"`
		Namespace     string                       `json:"source_namespace"`
		WorkspaceHash string                       `json:"workspace_hash"`
		Matches       bool                         `json:"matches_saved_baseline"`
		Frozen        bool                         `json:"source_frozen"`
		Quiesced      bool                         `json:"registered_writers_quiesced"`
		Execution     *bool                        `json:"execution_authorized"`
		Physical      *bool                        `json:"physical_quiescence_confirmed"`
		Workspaces    []historyActivationWorkspace `json:"workspaces"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Format != "loopwork-activation-source-inspection-v1" || result.CutoverID != uuidToString(row.ID) || result.ArchiveHash != row.ArchiveHash || result.ScopeHash != row.ScopeHash || result.Namespace != row.SourceNamespace || result.WorkspaceHash != expected || !result.Matches || !result.Frozen || !result.Quiesced || result.Execution == nil || *result.Execution || result.Physical == nil || *result.Physical || len(result.Workspaces) != len(row.ProjectIds) {
		return nil, nil, historyConflict("source or workspace activation observation is unavailable")
	}
	seen := map[string]bool{}
	for _, workspace := range result.Workspaces {
		if seen[workspace.ProjectID] || !filepath.IsAbs(workspace.Root) || workspace.Symlinks != 0 {
			return nil, nil, historyConflict("workspace links or correspondence require reconciliation before activation")
		}
		found := false
		for _, id := range row.ProjectIds {
			if uuidToString(id) == workspace.ProjectID {
				found = true
			}
		}
		if !found {
			return nil, nil, historyConflict("workspace project is outside the cutover")
		}
		seen[workspace.ProjectID] = true
	}
	return raw, result.Workspaces, nil
}

func historyLocalDaemonID() (string, error) {
	directory, err := cli.ProfileDir("")
	if err != nil {
		return "", err
	}
	// Read an existing machine identity; never initialize a daemon or discover CLIs.
	data, err := os.ReadFile(filepath.Join(directory, "daemon.id"))
	if err != nil {
		return "", historyConflict("register an explicitly selected runtime on this local machine first")
	}
	id := strings.TrimSpace(string(data))
	if _, err = util.ParseUUID(id); err != nil {
		return "", historyConflict("local daemon identity is unavailable")
	}
	return id, nil
}

func (h *Handler) historyActivationRoles(ctx context.Context, q *db.Queries, profiles []engineeringTeamSnapshot) ([]historyActivationRole, error) {
	ids := map[string]bool{}
	for _, profile := range profiles {
		required, known := engineeringTeamRoles[profile.Definition.Workflow]
		if !known || len(profile.Definition.Roles) != len(required) {
			return nil, historyConflict("prepared Team roles are unavailable")
		}
		team, err := q.LockSquadForAutopilotAssignment(ctx, db.LockSquadForAutopilotAssignmentParams{ID: parseUUID(profile.TeamID), WorkspaceID: parseUUID(localWorkspaceID)})
		if err != nil || team.ArchivedAt.Valid {
			return nil, historyConflict("prepared Team is unavailable")
		}
		members, err := q.ListSquadMembers(ctx, team.ID)
		if err != nil {
			return nil, err
		}
		roster := map[string]bool{uuidToString(team.LeaderID): true}
		for _, m := range members {
			if m.MemberType == "agent" {
				roster[uuidToString(m.MemberID)] = true
			}
		}
		roleIDs := []string{}
		for _, role := range required {
			roleIDs = append(roleIDs, profile.Definition.Roles[role])
		}
		if profile.Definition.Feedback != nil {
			roleIDs = append(roleIDs, profile.Definition.Feedback.ids()...)
		}
		for _, id := range roleIDs {
			if _, err := util.ParseUUID(id); err != nil || !roster[id] {
				return nil, historyConflict("prepared role is outside the Team")
			}
			ids[id] = true
		}
	}
	ordered := make([]string, 0, len(ids))
	for id := range ids {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	// Runtime teardown locks runtime rows before their Agents. Discover mappings
	// first, acquire in that order, then recheck every Agent under its row lock.
	agents := map[string]db.Agent{}
	runtimeIDs := map[string]bool{}
	for _, id := range ordered {
		a, err := q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: parseUUID(id), WorkspaceID: parseUUID(localWorkspaceID)})
		if err != nil || !a.RuntimeID.Valid {
			return nil, historyConflict("bind every prepared Team role to an explicit local runtime before activation")
		}
		agents[id] = a
		runtimeIDs[uuidToString(a.RuntimeID)] = true
	}
	daemon, err := historyLocalDaemonID()
	if err != nil {
		return nil, err
	}
	member, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: parseUUID(localUserID), WorkspaceID: parseUUID(localWorkspaceID)})
	if err != nil {
		return nil, err
	}
	runtimes := map[string]db.AgentRuntime{}
	runtimeOrder := make([]string, 0, len(runtimeIDs))
	for id := range runtimeIDs {
		runtimeOrder = append(runtimeOrder, id)
	}
	sort.Strings(runtimeOrder)
	for _, id := range runtimeOrder {
		rt, err := q.LockEngineeringHistoryRuntime(ctx, db.LockEngineeringHistoryRuntimeParams{ID: parseUUID(id), WorkspaceID: parseUUID(localWorkspaceID)})
		if err != nil || rt.RuntimeMode != "local" || !rt.DaemonID.Valid || rt.DaemonID.String != daemon || !canUseRuntimeForAgent(member, rt) || rt.Status != "online" || !rt.LastSeenAt.Valid || time.Since(rt.LastSeenAt.Time) > 2*time.Minute || rt.LastSeenAt.Time.After(time.Now().Add(time.Minute)) {
			return nil, historyConflict("activation requires an authorized, fresh runtime on this local machine")
		}
		runtimes[id] = rt
	}
	roles := []historyActivationRole{}
	for _, id := range ordered {
		a, err := q.LockAgentForAutopilotAssignment(ctx, db.LockAgentForAutopilotAssignmentParams{ID: parseUUID(id), WorkspaceID: parseUUID(localWorkspaceID)})
		if err != nil || a.RuntimeID != agents[id].RuntimeID || a.ArchivedAt.Valid || !h.canInvokeAgent(ctx, a, "member", localUserID, localUserID, localWorkspaceID) {
			return nil, historyConflict("prepared Team role invocation or runtime changed")
		}
		roles = append(roles, historyActivationRole{AgentID: id, RuntimeID: uuidToString(a.RuntimeID), DaemonID: runtimes[uuidToString(a.RuntimeID)].DaemonID.String})
	}
	return roles, nil
}

func (h *Handler) ActivateEngineeringHistoryCutover(w http.ResponseWriter, r *http.Request) {
	if !h.requireHistoryPreparation(w, r) {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "cutoverID"), "cutover_id")
	if !ok {
		return
	}
	var input struct {
		Scope     string `json:"expected_scope_hash"`
		Workspace string `json:"expected_workspace_hash"`
		Mode      string `json:"execution_mode"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || !historyDigest(input.Scope) || !historyDigest(input.Workspace) || input.Mode != localDirectoryModeInPlace && input.Mode != localDirectoryModeWorktree {
		writeError(w, 400, "activation requires the reviewed scope, workspace hash and execution mode")
		return
	}
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	q := h.Queries.WithTx(tx)
	workspace, human := parseUUID(localWorkspaceID), parseUUID(localUserID)
	row, err := q.LockEngineeringHistoryCutover(ctx, db.LockEngineeringHistoryCutoverParams{ID: id, WorkspaceID: workspace})
	if err != nil || row.PreparedBy != human || row.ArchiveHash != h.cfg.EngineeringHistoryHash || row.ScopeHash != input.Scope {
		writeError(w, 409, "cutover authority changed")
		return
	}
	if row.Phase == "activated" {
		var saved historyActivationReceipt
		if json.Unmarshal(row.Activation, &saved) != nil || saved.Format != "loopwork-native-activation-v1" || saved.CutoverID != uuidToString(id) || saved.WorkspaceHash != input.Workspace || saved.ExecutionMode != input.Mode {
			writeError(w, 409, "activation acknowledgement differs from the committed request")
			return
		}
		writeJSON(w, 200, saved)
		return
	}
	if row.Phase != "source_frozen" {
		writeError(w, 409, "only a frozen staged cutover can activate")
		return
	}
	var proposal historyCutoverPayload
	if json.Unmarshal(row.Payload, &proposal) != nil || proposal.Format != "loopwork-cutover-hold-v1" || len(proposal.Preparations) == 0 {
		writeError(w, 409, "cutover proposal is unavailable")
		return
	}
	adopted, err := q.ListEngineeringHistoryAdoptions(ctx, db.ListEngineeringHistoryAdoptionsParams{CutoverID: id, WorkspaceID: workspace})
	if err != nil || len(adopted) != len(proposal.Preparations) {
		writeError(w, 409, "stage the complete cohort before activation")
		return
	}
	preparations := map[string]db.EngineeringHistoryPreparation{}
	scopes := map[string]bool{}
	for _, p := range proposal.Preparations {
		prepID, parseErr := util.ParseUUID(p.ID)
		if parseErr != nil {
			writeError(w, 409, "preparation identity changed")
			return
		}
		prep, loadErr := q.GetEngineeringHistoryPreparationByID(ctx, db.GetEngineeringHistoryPreparationByIDParams{ID: prepID, WorkspaceID: workspace})
		if loadErr != nil || prep.PreparedBy != human || prep.SourceNamespace != row.SourceNamespace || prep.SourceTaskID != p.SourceTaskID || prep.Revision != p.Revision || prep.PacketHash != p.PacketHash || prep.ArchiveHash != row.ArchiveHash || uuidToString(prep.ProjectID) != p.ProjectID || uuidToString(prep.TeamID) != p.TeamID || prep.TeamRevision != p.TeamRevision {
			writeError(w, 409, "frozen preparation changed")
			return
		}
		preparations[p.SourceTaskID] = prep
		scopes[localWorkspaceID+":"+row.SourceNamespace+":"+prep.SourceProjectID] = true
	}
	orderedScopes := []string{}
	for scope := range scopes {
		orderedScopes = append(orderedScopes, scope)
	}
	sort.Strings(orderedScopes)
	for _, scope := range orderedScopes {
		if err = q.LockEngineeringHistoryPreparation(ctx, scope); err != nil {
			h.historyPreparationError(w, err)
			return
		}
	}
	for _, project := range row.ProjectIds {
		if _, err = q.LockEngineeringHistoryAdoptionProject(ctx, db.LockEngineeringHistoryAdoptionProjectParams{ID: project, WorkspaceID: workspace}); err != nil {
			h.historyPreparationError(w, err)
			return
		}
	}
	active, err := q.HasEngineeringHistoryProjectActivity(ctx, row.ProjectIds)
	if err != nil || !active.Valid || active.Bool {
		writeError(w, 409, "native resources or execution require reconciliation before activation")
		return
	}
	issues, err := q.ListEngineeringHistoryProjectIssues(ctx, db.ListEngineeringHistoryProjectIssuesParams{WorkspaceID: workspace, Column2: row.ProjectIds})
	if err != nil || len(issues) != len(adopted) {
		writeError(w, 409, "native cohort contains missing or unrelated tasks")
		return
	}
	native := map[pgtype.UUID]db.Issue{}
	for _, issue := range issues {
		native[issue.ID] = issue
	}
	profiles := []engineeringTeamSnapshot{}
	tasks := []map[string]any{}
	prefix := h.getIssuePrefix(ctx, workspace)
	for _, adoption := range adopted {
		prep, found := preparations[adoption.SourceTaskID]
		issue, issueFound := native[adoption.IssueID]
		if !found || !issueFound || adoption.Phase != "staged" || adoption.PreparationID != prep.ID || issue.ProjectID != prep.ProjectID || issue.AssigneeID != prep.TeamID || issue.AssigneeType.String != "squad" || issue.Status != "backlog" {
			writeError(w, 409, "staged task correspondence changed")
			return
		}
		var saved historyAdoptionPayload
		snapshot, snapshotErr := q.LockEngineeringHistoryIssueSnapshot(ctx, db.LockEngineeringHistoryIssueSnapshotParams{ID: issue.ID, WorkspaceID: workspace})
		if snapshotErr != nil || json.Unmarshal(adoption.Payload, &saved) != nil || saved.Format != "loopwork-native-task-adoption-v1" || saved.ScopeHash != row.ScopeHash || saved.PacketHash != prep.PacketHash || !historyJSONEqual(snapshot, saved.NativeIssue) {
			writeError(w, 409, "review changed native tasks before activation")
			return
		}
		versions, loadErr := q.ListEngineeringHistoryPreparations(ctx, db.ListEngineeringHistoryPreparationsParams{WorkspaceID: workspace, SourceNamespace: row.SourceNamespace, SourceTaskID: prep.SourceTaskID})
		if loadErr != nil || len(versions) == 0 || versions[0].ID != prep.ID {
			writeError(w, 409, "preparation version changed")
			return
		}
		source, loadErr := h.historyPreparationSource(ctx, prep.SourceTaskID)
		if loadErr != nil || len(historyPreparationBlockers(source)) > 0 || source.Material.Hash != prep.PacketHash {
			writeError(w, 409, "original task material changed")
			return
		}
		profile, rawProfile, loadErr := h.historyTeamProfile(ctx, uuidToString(prep.TeamID))
		var frozen struct {
			Profile json.RawMessage `json:"team_profile"`
			Packet  json.RawMessage `json:"packet"`
		}
		_ = json.Unmarshal(prep.Payload, &frozen)
		if loadErr != nil || profile.Definition.Workflow != historyWorkflow(source.ItemType) || profile.Revision != int(prep.TeamRevision) || !historyJSONEqual(rawProfile, frozen.Profile) || !historyJSONEqual(source.Packet, frozen.Packet) {
			writeError(w, 409, "prepared Team or source material changed")
			return
		}
		overview, loadErr := h.EngineeringWorker.Call(ctx, map[string]any{"action": "overview", "actor": map[string]string{"kind": "human", "workspaceId": localWorkspaceID, "userId": localUserID, "issueId": uuidToString(issue.ID)}})
		var state struct {
			Configured *bool `json:"configured"`
		}
		if loadErr != nil || json.Unmarshal(overview, &state) != nil || state.Configured == nil || *state.Configured {
			writeError(w, 409, "reconcile existing business workflows before activation")
			return
		}
		profiles = append(profiles, profile)
		task := historyAdoptionResponse(adoption, issue, prefix)
		task["phase"] = "activated"
		task["team_id"] = uuidToString(prep.TeamID)
		task["team_revision"] = prep.TeamRevision
		tasks = append(tasks, task)
	}
	roles, err := h.historyActivationRoles(ctx, q, profiles)
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	inspection, workspaces, err := h.inspectHistoryWorkspaces(ctx, row, input.Workspace)
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	if input.Mode == localDirectoryModeWorktree {
		for _, space := range workspaces {
			if space.Dirty {
				writeError(w, 409, "worktree activation requires a clean reviewed workspace; preserve existing changes")
				return
			}
		}
		runtimes, loadErr := q.ListAgentRuntimes(ctx, workspace)
		if loadErr != nil {
			h.historyPreparationError(w, loadErr)
			return
		}
		for _, role := range roles {
			if !daemonAdvertisesWorktree(runtimes, role.DaemonID) {
				writeError(w, 409, "local daemon must advertise worktree support before activation")
				return
			}
		}
	}
	receipt := historyActivationReceipt{Format: "loopwork-native-activation-v1", CutoverID: uuidToString(id), ScopeHash: row.ScopeHash, WorkspaceHash: input.Workspace, ActivatedBy: localUserID, ActivatedAt: time.Now().UTC().Format(time.RFC3339Nano), ExecutionMode: input.Mode, SourceInspection: inspection, Tasks: tasks, Resources: []historyActivationResource{}, Roles: roles}
	for _, space := range workspaces {
		resourceID, idErr := uuid.NewV7()
		if idErr != nil {
			h.historyPreparationError(w, idErr)
			return
		}
		ref, _ := json.Marshal(localDirectoryRef{LocalPath: space.Root, DaemonID: roles[0].DaemonID, ExecutionMode: input.Mode})
		receipt.Resources = append(receipt.Resources, historyActivationResource{ID: resourceID.String(), ProjectID: space.ProjectID, Ref: ref})
	}
	// Peers see the old hold until commit. Only this transaction sees its own
	// release, allowing the exact preallocated resources to be inserted atomically.
	raw, _ := json.Marshal(receipt)
	if _, err = q.ActivateEngineeringHistoryCutover(ctx, db.ActivateEngineeringHistoryCutoverParams{ID: id, WorkspaceID: workspace, Activation: raw}); err != nil {
		h.historyPreparationError(w, err)
		return
	}
	for _, resource := range receipt.Resources {
		if err = q.CreateEngineeringHistoryResource(ctx, db.CreateEngineeringHistoryResourceParams{ID: parseUUID(resource.ID), ProjectID: parseUUID(resource.ProjectID), WorkspaceID: workspace, ResourceRef: resource.Ref, CreatedBy: human}); err != nil {
			h.historyPreparationError(w, err)
			return
		}
	}
	published := []db.Issue{}
	for _, adoption := range adopted {
		if _, err = q.ActivateEngineeringHistoryAdoption(ctx, db.ActivateEngineeringHistoryAdoptionParams{CutoverID: id, WorkspaceID: workspace, SourceTaskID: adoption.SourceTaskID}); err != nil {
			h.historyPreparationError(w, err)
			return
		}
	}
	for _, adoption := range adopted {
		issue := native[adoption.IssueID]
		description := historyActivatedNotice + strings.TrimPrefix(issue.Description.String, historyPendingNotice)
		updated, updateErr := q.ActivateEngineeringHistoryDraftNotice(ctx, db.ActivateEngineeringHistoryDraftNoticeParams{ID: issue.ID, WorkspaceID: workspace, Description: pgtype.Text{String: description, Valid: true}})
		if updateErr != nil {
			h.historyPreparationError(w, updateErr)
			return
		}
		published = append(published, updated)
	}
	if err = tx.Commit(ctx); err != nil {
		h.historyPreparationError(w, err)
		return
	}
	for _, issue := range published {
		if h.Bus != nil {
			h.Bus.Publish(events.Event{Type: protocol.EventIssueUpdated, WorkspaceID: localWorkspaceID, ActorType: "member", ActorID: localUserID, Payload: map[string]any{"issue": issueToResponse(issue, prefix)}})
		}
	}
	writeJSON(w, 200, receipt)
}
