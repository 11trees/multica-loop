package handler

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type engineeringHistoryMaterial struct {
	Format string `json:"format"`
	Hash   string `json:"hash"`
	Source struct {
		Hash string `json:"hash"`
	} `json:"source"`
	SourceTaskID  string `json:"source_task_id"`
	SourceProject struct {
		ID        string  `json:"id"`
		Name      string  `json:"name"`
		DeletedAt *string `json:"deleted_at"`
	} `json:"source_project"`
	SourceTaskTerminal bool `json:"source_task_terminal"`
	SchemaComplete     bool `json:"schema_complete"`
	Ownership          struct {
		SourceOwner               string `json:"source_owner"`
		NativeExecutionAuthorized bool   `json:"native_execution_authorized"`
	} `json:"ownership"`
	Sections []struct {
		Table string                       `json:"table"`
		Rows  []map[string]json.RawMessage `json:"rows"`
	} `json:"sections"`
}
type engineeringHistoryPreparationSource struct {
	HistoricalOnly bool   `json:"historical_only"`
	Namespace      string `json:"namespace"`
	Source         struct {
		Hash string `json:"hash"`
	} `json:"source"`
	Packet   json.RawMessage            `json:"packet"`
	Material engineeringHistoryMaterial `json:"-"`
	ItemType string                     `json:"-"`
}

func historyDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 32 && strings.ToLower(value) == value
}

func (h *Handler) historyPreparationSource(ctx context.Context, taskID string) (engineeringHistoryPreparationSource, error) {
	var source engineeringHistoryPreparationSource
	raw, err := h.EngineeringHistoryWorker.Call(ctx, map[string]any{"action": "preparation-source", "expected_hash": h.cfg.EngineeringHistoryHash, "task_id": taskID})
	if err != nil {
		return source, err
	}
	if json.Unmarshal(raw, &source) != nil || !source.HistoricalOnly || source.Source.Hash != h.cfg.EngineeringHistoryHash || !historyDigest(source.Namespace) {
		return source, errors.New("historical preparation source is unavailable")
	}
	if string(source.Packet) == "null" {
		return source, pgx.ErrNoRows
	}
	material := &source.Material
	if json.Unmarshal(source.Packet, material) != nil || material.Format != "loopwork-task-handoff-v1" || material.SourceTaskID != taskID || material.SourceProject.ID == "" || !historyDigest(material.Hash) || material.Source.Hash != source.Source.Hash || material.Ownership.SourceOwner != "LoopWork" || material.Ownership.NativeExecutionAuthorized {
		return source, errors.New("historical material identity changed")
	}
	for _, section := range material.Sections {
		if section.Table == "tasks" && len(section.Rows) == 1 {
			_ = json.Unmarshal(section.Rows[0]["item_type"], &source.ItemType)
		}
	}
	return source, nil
}
func historyWorkflow(itemType string) string {
	switch itemType {
	case "feature":
		return "develop"
	case "business-analysis":
		return "business_analysis"
	case "end-to-end":
		return "end_to_end"
	case "bug":
		return "bug_fix"
	}
	return ""
}
func historyPreparationBlockers(source engineeringHistoryPreparationSource) []string {
	blockers := []string{}
	if source.Material.SourceProject.DeletedAt != nil {
		blockers = append(blockers, "source_project_deleted")
	}
	if source.Material.SourceTaskTerminal {
		blockers = append(blockers, "source_task_terminal")
	}
	if !source.Material.SchemaComplete || len(source.Material.Sections) != 31 {
		blockers = append(blockers, "incomplete_material")
	}
	if historyWorkflow(source.ItemType) == "" {
		blockers = append(blockers, "unsupported_task_kind")
	}
	return blockers
}

type historyTeamChoice struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Revision int    `json:"revision"`
	Workflow string `json:"workflow"`
}

func (h *Handler) historyTeamProfile(ctx context.Context, teamID string) (engineeringTeamSnapshot, json.RawMessage, error) {
	var result struct {
		Profile *engineeringTeamSnapshot `json:"profile"`
	}
	raw, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "team-lookup", "actor": map[string]string{"kind": "coordinator"}, "payload": map[string]string{"workspace_id": localWorkspaceID, "team_id": teamID}})
	if err != nil {
		return engineeringTeamSnapshot{}, nil, err
	}
	if json.Unmarshal(raw, &result) != nil || result.Profile == nil || result.Profile.WorkspaceID != localWorkspaceID || result.Profile.TeamID != teamID || result.Profile.Revision < 1 {
		return engineeringTeamSnapshot{}, nil, &engineering.Rejection{Message: "Team workflow is unavailable", Conflict: true}
	}
	var saved struct {
		Profile json.RawMessage `json:"profile"`
	}
	_ = json.Unmarshal(raw, &saved)
	return *result.Profile, saved.Profile, nil
}
func (h *Handler) requireHistoryPreparation(w http.ResponseWriter, r *http.Request) bool {
	if !h.engineeringHistoryAvailable(r) {
		writeError(w, http.StatusForbidden, "historical preparation requires the configured local human")
		return false
	}
	if h.EngineeringWorker == nil || h.TxStarter == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering preparation is unavailable")
		return false
	}
	_, ok := h.requireWorkspaceRole(w, r, localWorkspaceID, "workspace not found", "owner", "admin")
	return ok
}
func historyPreparationResponse(row db.EngineeringHistoryPreparation, current bool) map[string]any {
	return map[string]any{"id": uuidToString(row.ID), "revision": row.Revision, "archive_hash": row.ArchiveHash, "packet_hash": row.PacketHash, "project_id": uuidToString(row.ProjectID), "team_id": uuidToString(row.TeamID), "team_revision": row.TeamRevision, "prepared_by": uuidToString(row.PreparedBy), "created_at": row.CreatedAt.Time, "current": current, "source_owner": "LoopWork", "execution_authorized": false}
}
func (h *Handler) GetEngineeringHistoryPreparation(w http.ResponseWriter, r *http.Request) {
	if !h.requireHistoryPreparation(w, r) {
		return
	}
	source, err := h.historyPreparationSource(r.Context(), chi.URLParam(r, "sourceTaskID"))
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	ctx := r.Context()
	workspace := parseUUID(localWorkspaceID)
	teams, err := h.Queries.ListSquads(ctx, workspace)
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	choices := []historyTeamChoice{}
	revisions := map[string]int{}
	for _, team := range teams {
		profile, _, lookupErr := h.historyTeamProfile(ctx, uuidToString(team.ID))
		if lookupErr != nil {
			var rejected *engineering.Rejection
			if errors.As(lookupErr, &rejected) {
				continue
			}
			h.historyPreparationError(w, lookupErr)
			return
		}
		if profile.Definition.Workflow == historyWorkflow(source.ItemType) {
			choices = append(choices, historyTeamChoice{uuidToString(team.ID), team.Name, profile.Revision, profile.Definition.Workflow})
			revisions[uuidToString(team.ID)] = profile.Revision
		}
	}
	mapped, err := h.Queries.GetEngineeringHistoryProject(ctx, db.GetEngineeringHistoryProjectParams{WorkspaceID: workspace, SourceNamespace: source.Namespace, SourceProjectID: source.Material.SourceProject.ID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		h.historyPreparationError(w, err)
		return
	}
	projects, err := h.Queries.ListProjects(ctx, db.ListProjectsParams{WorkspaceID: workspace})
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	visible, ok := h.requestHiddenProjects(w, r, localWorkspaceID)
	if !ok {
		return
	}
	nativeProjects := []map[string]string{}
	available := map[string]bool{}
	for _, project := range projects {
		if visible.CanSeeProject(project.ID) && project.Status != "completed" && project.Status != "cancelled" {
			id := uuidToString(project.ID)
			nativeProjects = append(nativeProjects, map[string]string{"id": id, "title": project.Title})
			available[id] = true
		}
	}
	blockers := historyPreparationBlockers(source)
	if len(choices) == 0 {
		blockers = append(blockers, "no_compatible_team")
	}
	mappedID := ""
	if mapped.ProjectID.Valid {
		mappedID = uuidToString(mapped.ProjectID)
		if !available[mappedID] {
			blockers = append(blockers, "mapped_project_unavailable")
		}
	}
	rows, err := h.Queries.ListEngineeringHistoryPreparations(ctx, db.ListEngineeringHistoryPreparationsParams{WorkspaceID: workspace, SourceNamespace: source.Namespace, SourceTaskID: source.Material.SourceTaskID})
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	preparations := []map[string]any{}
	for index, row := range rows {
		current := index == 0 && row.PacketHash == source.Material.Hash && row.ArchiveHash == source.Source.Hash && int(row.TeamRevision) == revisions[uuidToString(row.TeamID)] && available[uuidToString(row.ProjectID)] && len(blockers) == 0
		preparations = append(preparations, historyPreparationResponse(row, current))
	}
	adopted, err := h.Queries.ListEngineeringHistoryTaskAdoptions(ctx, db.ListEngineeringHistoryTaskAdoptionsParams{WorkspaceID: workspace, SourceNamespace: source.Namespace, SourceTaskID: source.Material.SourceTaskID})
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	adoptions := []map[string]any{}
	prefix := h.getIssuePrefix(ctx, workspace)
	for _, row := range adopted {
		identifier := ""
		if row.IssueNumber.Valid {
			identifier = prefix + "-" + int32String(row.IssueNumber.Int32)
		}
		adoptions = append(adoptions, map[string]any{"cutover_id": uuidToString(row.CutoverID), "preparation_id": uuidToString(row.PreparationID), "issue_id": uuidToString(row.IssueID), "identifier": identifier, "phase": row.Phase, "native_available": row.IssueNumber.Valid, "execution_authorized": false})
	}
	writeJSON(w, http.StatusOK, map[string]any{"source_owner": "LoopWork", "execution_authorized": false, "source_task_id": source.Material.SourceTaskID, "packet_hash": source.Material.Hash, "archive_hash": source.Source.Hash, "mapped_project_id": mappedID, "projects": nativeProjects, "teams": choices, "blockers": blockers, "preparations": preparations, "adoptions": adoptions})
}

type historyPreparationRequest struct {
	ExpectedRevision     *int32  `json:"expected_revision"`
	ExpectedPacketHash   string  `json:"expected_packet_hash"`
	TeamID               string  `json:"team_id"`
	ExpectedTeamRevision int32   `json:"expected_team_revision"`
	ProjectID            *string `json:"project_id"`
	CreateProject        bool    `json:"create_project"`
}

func (h *Handler) PrepareEngineeringHistoryTask(w http.ResponseWriter, r *http.Request) {
	if !h.requireHistoryPreparation(w, r) {
		return
	}
	var input historyPreparationRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.ExpectedRevision == nil || *input.ExpectedRevision < 0 || input.ExpectedTeamRevision < 1 || !historyDigest(input.ExpectedPacketHash) || input.CreateProject && input.ProjectID != nil {
		writeError(w, http.StatusBadRequest, "invalid historical preparation request")
		return
	}
	teamID, ok := parseUUIDOrBadRequest(w, input.TeamID, "team_id")
	if !ok {
		return
	}
	var projectID pgtype.UUID
	if input.ProjectID != nil {
		projectID, ok = parseUUIDOrBadRequest(w, *input.ProjectID, "project_id")
		if !ok {
			return
		}
	}
	source, err := h.historyPreparationSource(r.Context(), chi.URLParam(r, "sourceTaskID"))
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	if len(historyPreparationBlockers(source)) > 0 || source.Material.Hash != input.ExpectedPacketHash {
		writeError(w, http.StatusConflict, "historical task or frozen material is not ready for preparation")
		return
	}
	ctx := r.Context()
	workspace, user := parseUUID(localWorkspaceID), parseUUID(localUserID)
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	q := h.Queries.WithTx(tx)
	if err = q.LockEngineeringHistoryPreparation(ctx, localWorkspaceID+":"+source.Namespace+":"+source.Material.SourceProject.ID); err != nil {
		h.historyPreparationError(w, err)
		return
	}
	adoptions, err := q.ListEngineeringHistoryTaskAdoptions(ctx, db.ListEngineeringHistoryTaskAdoptionsParams{WorkspaceID: workspace, SourceNamespace: source.Namespace, SourceTaskID: source.Material.SourceTaskID})
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	for _, adoption := range adoptions {
		if adoption.Phase != "withdrawn" {
			writeError(w, http.StatusConflict, "native migration task is already staged")
			return
		}
	}
	rows, err := q.ListEngineeringHistoryPreparations(ctx, db.ListEngineeringHistoryPreparationsParams{WorkspaceID: workspace, SourceNamespace: source.Namespace, SourceTaskID: source.Material.SourceTaskID})
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	revision := int32(0)
	if len(rows) > 0 {
		revision = rows[0].Revision
	}
	mapped, err := q.GetEngineeringHistoryProject(ctx, db.GetEngineeringHistoryProjectParams{WorkspaceID: workspace, SourceNamespace: source.Namespace, SourceProjectID: source.Material.SourceProject.ID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		h.historyPreparationError(w, err)
		return
	}
	if mapped.ProjectID.Valid {
		if projectID.Valid && projectID != mapped.ProjectID {
			writeError(w, http.StatusConflict, "the source project already has a native correspondence")
			return
		}
		projectID = mapped.ProjectID
	}
	same := len(rows) > 0 && rows[0].ArchiveHash == source.Source.Hash && rows[0].PacketHash == input.ExpectedPacketHash && rows[0].TeamID == teamID && rows[0].TeamRevision == input.ExpectedTeamRevision && rows[0].ProjectID == projectID && rows[0].PreparedBy == user
	if revision != *input.ExpectedRevision && !(same && *input.ExpectedRevision == revision-1) {
		writeError(w, http.StatusConflict, "preparation version changed; reload before saving")
		return
	}
	if revision == 2147483647 && !same {
		writeError(w, http.StatusConflict, "preparation version limit reached")
		return
	}
	var created *db.Project
	if !projectID.Valid {
		if !input.CreateProject {
			writeError(w, http.StatusBadRequest, "choose a native project or create the source project")
			return
		}
		project, createErr := q.CreateProject(ctx, db.CreateProjectParams{WorkspaceID: workspace, Title: source.Material.SourceProject.Name, Status: "planned", Priority: "none", CreatorType: pgtype.Text{String: "member", Valid: true}, CreatorID: user})
		if createErr != nil {
			h.historyPreparationError(w, createErr)
			return
		}
		projectID = project.ID
		created = &project
	}
	project, err := q.LockEngineeringHistoryTargetProject(ctx, db.LockEngineeringHistoryTargetProjectParams{ID: projectID, WorkspaceID: workspace})
	if err != nil {
		writeError(w, http.StatusConflict, "native project is unavailable")
		return
	}
	if project.Status == "completed" || project.Status == "cancelled" {
		writeError(w, http.StatusConflict, "native project is unavailable")
		return
	}
	if !h.requireProjectVisible(w, r, localWorkspaceID, projectID, http.StatusNotFound, "project not found") {
		return
	}
	team, err := q.LockSquadForAutopilotAssignment(ctx, db.LockSquadForAutopilotAssignmentParams{ID: teamID, WorkspaceID: workspace})
	if err != nil || team.ArchivedAt.Valid {
		writeError(w, http.StatusConflict, "Team is unavailable")
		return
	}
	profile, profileRaw, err := h.historyTeamProfile(ctx, uuidToString(teamID))
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	if int32(profile.Revision) != input.ExpectedTeamRevision || profile.Definition.Workflow != historyWorkflow(source.ItemType) {
		writeError(w, http.StatusConflict, "Team version or workflow changed; reload before saving")
		return
	}
	if !mapped.ProjectID.Valid {
		if _, err = q.CreateEngineeringHistoryProject(ctx, db.CreateEngineeringHistoryProjectParams{WorkspaceID: workspace, SourceNamespace: source.Namespace, SourceProjectID: source.Material.SourceProject.ID, ProjectID: projectID, CreatedBy: user}); err != nil {
			h.historyPreparationError(w, err)
			return
		}
	}
	if same {
		if err = tx.Commit(ctx); err != nil {
			h.historyPreparationError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, historyPreparationResponse(rows[0], true))
		return
	}
	payload, err := json.Marshal(map[string]any{"packet": source.Packet, "team_profile": profileRaw, "source_namespace": source.Namespace, "source_owner": "LoopWork", "execution_authorized": false})
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	row, err := q.CreateEngineeringHistoryPreparation(ctx, db.CreateEngineeringHistoryPreparationParams{WorkspaceID: workspace, SourceNamespace: source.Namespace, SourceProjectID: source.Material.SourceProject.ID, SourceTaskID: source.Material.SourceTaskID, Revision: revision + 1, ArchiveHash: source.Source.Hash, PacketHash: source.Material.Hash, ProjectID: projectID, TeamID: teamID, TeamRevision: input.ExpectedTeamRevision, PreparedBy: user, Payload: payload})
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		h.historyPreparationError(w, err)
		return
	}
	if created != nil {
		h.publish(protocol.EventProjectCreated, localWorkspaceID, "member", localUserID, map[string]any{"project": projectToResponse(*created)})
	}
	writeJSON(w, http.StatusOK, historyPreparationResponse(row, true))
}
func (h *Handler) historyPreparationError(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "historical task not found")
		return
	}
	engineeringControlError(w, err)
}
