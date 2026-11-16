package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type historyCutoverPayload struct {
	Format       string `json:"format"`
	Preparations []struct {
		ID           string `json:"id"`
		Revision     int32  `json:"revision"`
		SourceTaskID string `json:"source_task_id"`
		PacketHash   string `json:"packet_hash"`
		ProjectID    string `json:"project_id"`
		TeamID       string `json:"team_id"`
		TeamRevision int32  `json:"team_revision"`
	} `json:"preparations"`
}
type historyAdoptionPayload struct {
	Format      string          `json:"format"`
	ScopeHash   string          `json:"scope_hash"`
	PacketHash  string          `json:"packet_hash"`
	Inspection  json.RawMessage `json:"inspection"`
	NativeIssue json.RawMessage `json:"native_issue"`
}

const historyPendingNotice = "Migration pending. Confirm the original task and materials before starting."
const historyActivatedNotice = "Imported from LoopWork. Original source states and materials remain historical."

func historyConflict(message string) error {
	return &engineering.Rejection{Message: message, Conflict: true}
}
func historyJSONEqual(a, b []byte) bool {
	var left, right any
	return json.Unmarshal(a, &left) == nil && json.Unmarshal(b, &right) == nil && reflect.DeepEqual(left, right)
}
func historyDraftDescription(taskID string, source engineeringHistoryPreparationSource) (string, string, error) {
	for _, section := range source.Material.Sections {
		if section.Table == "tasks" && len(section.Rows) == 1 {
			row := section.Rows[0]
			var title, description, status, run, closure string
			_ = json.Unmarshal(row["title"], &title)
			_ = json.Unmarshal(row["description"], &description)
			_ = json.Unmarshal(row["agile_status"], &status)
			_ = json.Unmarshal(row["run_state"], &run)
			_ = json.Unmarshal(row["closure_status"], &closure)
			fence := "```"
			states, _ := json.Marshal([]string{status, run, closure})
			for strings.Contains(description+string(states), fence) {
				fence += "`"
			}
			body := historyPendingNotice + "\n\nSource status:\n\n" + fence + "text\n" + string(states) + "\n" + fence + "\n\n[Original task and materials](/loopwork-local/history?task=" + url.QueryEscape(taskID) + ")\n\nOriginal description:\n\n" + fence + "text\n" + description + "\n" + fence + "\n"
			if strings.TrimSpace(title) == "" {
				return "", "", historyConflict("original task goal is unavailable")
			}
			return title, body, nil
		}
	}
	return "", "", historyConflict("original task goal is unavailable")
}
func (h *Handler) inspectHistoryCutover(ctx context.Context, row db.EngineeringHistoryCutover) (json.RawMessage, error) {
	if h.EngineeringSourceInspector == nil {
		return nil, errors.New("source inspector is unavailable")
	}
	raw, err := h.EngineeringSourceInspector.Call(ctx, map[string]any{"action": "inspect", "expected_hash": h.cfg.EngineeringHistoryHash, "record": map[string]any{"id": uuidToString(row.ID), "archive_hash": row.ArchiveHash, "scope_hash": row.ScopeHash, "source_namespace": row.SourceNamespace, "payload": json.RawMessage(row.Payload)}})
	if err != nil {
		return nil, err
	}
	var result struct {
		Format      string `json:"format"`
		CutoverID   string `json:"cutover_id"`
		ArchiveHash string `json:"archive_hash"`
		ScopeHash   string `json:"scope_hash"`
		Namespace   string `json:"source_namespace"`
		Frozen      bool   `json:"source_frozen"`
		Quiesced    bool   `json:"registered_writers_quiesced"`
		Execution   *bool  `json:"execution_authorized"`
		Physical    *bool  `json:"physical_quiescence_confirmed"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Format != "loopwork-native-source-inspection-v1" || result.CutoverID != uuidToString(row.ID) || result.ArchiveHash != row.ArchiveHash || result.ScopeHash != row.ScopeHash || result.Namespace != row.SourceNamespace || !result.Frozen || !result.Quiesced || result.Execution == nil || *result.Execution || result.Physical == nil || *result.Physical {
		return nil, historyConflict("source cutover observation is unavailable")
	}
	return raw, nil
}
func historyAdoptionResponse(row db.EngineeringHistoryAdoption, issue db.Issue, prefix string) map[string]any {
	return map[string]any{"cutover_id": uuidToString(row.CutoverID), "preparation_id": uuidToString(row.PreparationID), "source_task_id": row.SourceTaskID, "issue_id": uuidToString(row.IssueID), "identifier": prefix + "-" + int32String(issue.Number), "phase": row.Phase, "execution_authorized": false}
}
func int32String(value int32) string { return fmt.Sprint(value) }

func (h *Handler) StageEngineeringHistoryCutover(w http.ResponseWriter, r *http.Request) {
	h.writeHistoryAdoption(w, r, false)
}
func (h *Handler) WithdrawEngineeringHistoryCutover(w http.ResponseWriter, r *http.Request) {
	h.writeHistoryAdoption(w, r, true)
}
func (h *Handler) writeHistoryAdoption(w http.ResponseWriter, r *http.Request, withdraw bool) {
	if !h.requireHistoryPreparation(w, r) {
		return
	}
	cutover, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "cutoverID"), "cutover_id")
	if !ok {
		return
	}
	var input struct {
		ExpectedScopeHash string `json:"expected_scope_hash"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || !historyDigest(input.ExpectedScopeHash) {
		writeError(w, 400, "invalid cutover adoption request")
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
	row, err := q.LockEngineeringHistoryCutover(ctx, db.LockEngineeringHistoryCutoverParams{ID: cutover, WorkspaceID: workspace})
	if err != nil || row.ArchiveHash != h.cfg.EngineeringHistoryHash || row.PreparedBy != human || row.ScopeHash != input.ExpectedScopeHash || row.Phase != "source_frozen" {
		writeError(w, 409, "cutover is not frozen for this human and archive")
		return
	}
	var payload historyCutoverPayload
	if json.Unmarshal(row.Payload, &payload) != nil || payload.Format != "loopwork-cutover-hold-v1" || len(payload.Preparations) == 0 {
		writeError(w, 409, "cutover proposal is unavailable")
		return
	}
	existing, err := q.ListEngineeringHistoryAdoptions(ctx, db.ListEngineeringHistoryAdoptionsParams{CutoverID: cutover, WorkspaceID: workspace})
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	// A committed draft cohort is its own acknowledgement. Replays do not
	// recreate tasks or depend on a source process/archive being available now.
	if !withdraw && len(existing) > 0 {
		if len(existing) != len(payload.Preparations) {
			writeError(w, 409, "native migration correspondence is incomplete")
			return
		}
		result := []map[string]any{}
		prefix := h.getIssuePrefix(ctx, workspace)
		for _, adoption := range existing {
			var saved historyAdoptionPayload
			if adoption.Phase != "staged" || json.Unmarshal(adoption.Payload, &saved) != nil || saved.Format != "loopwork-native-task-adoption-v1" || saved.ScopeHash != row.ScopeHash {
				writeError(w, 409, "native migration receipt changed or was withdrawn")
				return
			}
			issue, loadErr := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: adoption.IssueID, WorkspaceID: workspace})
			if loadErr != nil {
				writeError(w, 409, "staged native task is unavailable")
				return
			}
			result = append(result, historyAdoptionResponse(adoption, issue, prefix))
		}
		if err = tx.Commit(ctx); err != nil {
			h.historyPreparationError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"cutover_id": uuidToString(cutover), "tasks": result, "execution_authorized": false})
		return
	}
	scopes := map[string]bool{}
	for _, proposal := range payload.Preparations {
		id, parseErr := util.ParseUUID(proposal.ID)
		if parseErr != nil {
			writeError(w, 409, "preparation identity changed")
			return
		}
		prep, loadErr := q.GetEngineeringHistoryPreparationByID(ctx, db.GetEngineeringHistoryPreparationByIDParams{ID: id, WorkspaceID: workspace})
		if loadErr != nil {
			writeError(w, 409, "preparation identity changed")
			return
		}
		scopes[localWorkspaceID+":"+row.SourceNamespace+":"+prep.SourceProjectID] = true
	}
	ordered := make([]string, 0, len(scopes))
	for scope := range scopes {
		ordered = append(ordered, scope)
	}
	sort.Strings(ordered)
	for _, scope := range ordered {
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
		writeError(w, 409, "native project has resources or execution requiring reconciliation")
		return
	}
	issues, err := q.ListEngineeringHistoryProjectIssues(ctx, db.ListEngineeringHistoryProjectIssuesParams{WorkspaceID: workspace, Column2: row.ProjectIds})
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	owned := map[pgtype.UUID]db.EngineeringHistoryAdoption{}
	for _, adoption := range existing {
		owned[adoption.IssueID] = adoption
	}
	for _, issue := range issues {
		if _, found := owned[issue.ID]; !found {
			writeError(w, 409, "native project contains unrelated work")
			return
		}
	}
	if len(existing) > 0 && len(existing) != len(payload.Preparations) {
		writeError(w, 409, "native migration correspondence is incomplete")
		return
	}
	if withdraw && len(existing) == 0 {
		writeError(w, 409, "no staged migration tasks exist")
		return
	}
	inspection, err := h.inspectHistoryCutover(ctx, row)
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	result := []map[string]any{}
	published := []db.Issue{}
	prefix := h.getIssuePrefix(ctx, workspace)
	if len(existing) > 0 {
		for _, adoption := range existing {
			var saved historyAdoptionPayload
			if json.Unmarshal(adoption.Payload, &saved) != nil || saved.Format != "loopwork-native-task-adoption-v1" || saved.ScopeHash != row.ScopeHash {
				writeError(w, 409, "native migration receipt changed")
				return
			}
			issue, loadErr := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: adoption.IssueID, WorkspaceID: workspace})
			if loadErr != nil {
				writeError(w, 409, "staged native task is unavailable")
				return
			}
			if !withdraw && adoption.Phase != "staged" {
				writeError(w, 409, "withdrawn cutover cannot stage another generation")
				return
			}
			if withdraw && adoption.Phase == "staged" {
				snapshot, snapshotErr := q.LockEngineeringHistoryIssueSnapshot(ctx, db.LockEngineeringHistoryIssueSnapshotParams{ID: issue.ID, WorkspaceID: workspace})
				if snapshotErr != nil || !historyJSONEqual(snapshot, saved.NativeIssue) {
					writeError(w, 409, "native task changed; review it before withdrawal")
					return
				}
				raw, overviewErr := h.EngineeringWorker.Call(ctx, map[string]any{"action": "overview", "actor": map[string]string{"kind": "human", "userId": localUserID, "workspaceId": localWorkspaceID, "issueId": uuidToString(issue.ID)}})
				var overview struct {
					Configured *bool `json:"configured"`
				}
				if overviewErr != nil || json.Unmarshal(raw, &overview) != nil || overview.Configured == nil || *overview.Configured {
					writeError(w, 409, "native workflow needs reconciliation before withdrawal")
					return
				}
				adoption, err = q.WithdrawEngineeringHistoryAdoption(ctx, db.WithdrawEngineeringHistoryAdoptionParams{CutoverID: cutover, WorkspaceID: workspace, SourceTaskID: adoption.SourceTaskID})
				if err != nil {
					h.historyPreparationError(w, err)
					return
				}
				issue, err = q.CancelEngineeringHistoryDraft(ctx, db.CancelEngineeringHistoryDraftParams{ID: issue.ID, WorkspaceID: workspace})
				if err != nil {
					h.historyPreparationError(w, err)
					return
				}
				published = append(published, issue)
			}
			result = append(result, historyAdoptionResponse(adoption, issue, prefix))
		}
	} else {
		for _, proposal := range payload.Preparations {
			id, parseErr := util.ParseUUID(proposal.ID)
			if parseErr != nil {
				writeError(w, 409, "preparation identity changed")
				return
			}
			prep, loadErr := q.GetEngineeringHistoryPreparationByID(ctx, db.GetEngineeringHistoryPreparationByIDParams{ID: id, WorkspaceID: workspace})
			if loadErr != nil || prep.SourceNamespace != row.SourceNamespace || prep.SourceTaskID != proposal.SourceTaskID || prep.Revision != proposal.Revision || prep.PacketHash != proposal.PacketHash || prep.ArchiveHash != row.ArchiveHash || uuidToString(prep.ProjectID) != proposal.ProjectID || uuidToString(prep.TeamID) != proposal.TeamID || prep.TeamRevision != proposal.TeamRevision || prep.PreparedBy != human {
				writeError(w, 409, "frozen preparation changed")
				return
			}
			if err = q.LockEngineeringHistoryPreparation(ctx, localWorkspaceID+":"+row.SourceNamespace+":"+prep.SourceProjectID); err != nil {
				h.historyPreparationError(w, err)
				return
			}
			versions, loadErr := q.ListEngineeringHistoryPreparations(ctx, db.ListEngineeringHistoryPreparationsParams{WorkspaceID: workspace, SourceNamespace: row.SourceNamespace, SourceTaskID: prep.SourceTaskID})
			if loadErr != nil || len(versions) == 0 || versions[0].ID != prep.ID {
				writeError(w, 409, "preparation version changed")
				return
			}
			source, loadErr := h.historyPreparationSource(ctx, prep.SourceTaskID)
			if loadErr != nil || source.Material.Hash != prep.PacketHash || len(historyPreparationBlockers(source)) > 0 {
				writeError(w, 409, "original material changed")
				return
			}
			if _, err = q.LockSquadForAutopilotAssignment(ctx, db.LockSquadForAutopilotAssignmentParams{ID: prep.TeamID, WorkspaceID: workspace}); err != nil {
				h.historyPreparationError(w, err)
				return
			}
			profile, rawProfile, loadErr := h.historyTeamProfile(ctx, uuidToString(prep.TeamID))
			var frozen struct {
				Profile json.RawMessage `json:"team_profile"`
				Packet  json.RawMessage `json:"packet"`
			}
			_ = json.Unmarshal(prep.Payload, &frozen)
			if loadErr != nil || profile.Definition.Workflow != historyWorkflow(source.ItemType) || int32(profile.Revision) != prep.TeamRevision || !historyJSONEqual(rawProfile, frozen.Profile) || !historyJSONEqual(source.Packet, frozen.Packet) {
				writeError(w, 409, "prepared Team or material changed")
				return
			}
			title, description, loadErr := historyDraftDescription(prep.SourceTaskID, source)
			if loadErr != nil {
				h.historyPreparationError(w, loadErr)
				return
			}
			issue, createErr := h.IssueService.StageHistoryDraft(ctx, tx, workspace, prep.ProjectID, prep.TeamID, human, title, description)
			if createErr != nil {
				h.historyPreparationError(w, createErr)
				return
			}
			snapshot, snapshotErr := q.LockEngineeringHistoryIssueSnapshot(ctx, db.LockEngineeringHistoryIssueSnapshotParams{ID: issue.ID, WorkspaceID: workspace})
			if snapshotErr != nil {
				h.historyPreparationError(w, snapshotErr)
				return
			}
			frozenPayload, _ := json.Marshal(historyAdoptionPayload{Format: "loopwork-native-task-adoption-v1", ScopeHash: row.ScopeHash, PacketHash: prep.PacketHash, Inspection: inspection, NativeIssue: snapshot})
			adoption, createErr := q.CreateEngineeringHistoryAdoption(ctx, db.CreateEngineeringHistoryAdoptionParams{CutoverID: cutover, WorkspaceID: workspace, SourceNamespace: row.SourceNamespace, SourceTaskID: prep.SourceTaskID, PreparationID: prep.ID, IssueID: issue.ID, Payload: frozenPayload})
			if createErr != nil {
				h.historyPreparationError(w, createErr)
				return
			}
			result = append(result, historyAdoptionResponse(adoption, issue, prefix))
			published = append(published, issue)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i]["source_task_id"].(string) < result[j]["source_task_id"].(string)
	})
	if err = tx.Commit(ctx); err != nil {
		h.historyPreparationError(w, err)
		return
	}
	for _, issue := range published {
		if h.Bus != nil {
			eventType := protocol.EventIssueCreated
			if withdraw {
				eventType = protocol.EventIssueUpdated
			}
			h.Bus.Publish(events.Event{Type: eventType, WorkspaceID: localWorkspaceID, ActorType: "member", ActorID: localUserID, Payload: map[string]any{"issue": issueToResponse(issue, prefix)}})
		}
	}
	writeJSON(w, 200, map[string]any{"cutover_id": uuidToString(cutover), "tasks": result, "execution_authorized": false})
}
