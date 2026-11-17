package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type historyDeactivationReceipt struct {
	Format           string                      `json:"format"`
	CutoverID        string                      `json:"cutover_id"`
	ScopeHash        string                      `json:"scope_hash"`
	WorkspaceHash    string                      `json:"workspace_hash"`
	DeactivatedBy    string                      `json:"deactivated_by"`
	DeactivatedAt    string                      `json:"deactivated_at"`
	Activation       json.RawMessage             `json:"activation"`
	SourceInspection json.RawMessage             `json:"source_inspection"`
	Tasks            []map[string]any            `json:"tasks"`
	Resources        []historyActivationResource `json:"resources"`
	ExecutionStarted bool                        `json:"execution_started"`
}

func unchangedActivatedHistoryIssue(original, current json.RawMessage) bool {
	var before, after map[string]json.RawMessage
	if json.Unmarshal(original, &before) != nil || json.Unmarshal(current, &after) != nil {
		return false
	}
	var description string
	var revision int64
	if json.Unmarshal(before["description"], &description) != nil || !strings.HasPrefix(description, historyPendingNotice) || json.Unmarshal(before["revision"], &revision) != nil {
		return false
	}
	before["description"], _ = json.Marshal(historyActivatedNotice + strings.TrimPrefix(description, historyPendingNotice))
	before["revision"], _ = json.Marshal(revision + 1)
	// Activation intentionally updates activity timestamps. Every semantic field,
	// creation identity and the exact one-step revision still has to match.
	for _, key := range []string{"updated_at_epoch", "last_activity_at_epoch"} {
		delete(before, key)
		delete(after, key)
	}
	left, _ := json.Marshal(before)
	right, _ := json.Marshal(after)
	return historyJSONEqual(left, right)
}

func (h *Handler) DeactivateEngineeringHistoryCutover(w http.ResponseWriter, r *http.Request) {
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
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || !historyDigest(input.Scope) || !historyDigest(input.Workspace) {
		writeError(w, 400, "deactivation requires the original reviewed scope and workspace hash")
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
	if len(row.Deactivation) > 0 {
		var saved historyDeactivationReceipt
		if json.Unmarshal(row.Deactivation, &saved) != nil || saved.Format != "loopwork-native-deactivation-v1" || saved.CutoverID != uuidToString(id) || saved.WorkspaceHash != input.Workspace {
			writeError(w, 409, "deactivation acknowledgement differs from the committed request")
			return
		}
		writeJSON(w, 200, saved)
		return
	}
	var activation historyActivationReceipt
	if row.Phase != "activated" || json.Unmarshal(row.Activation, &activation) != nil || activation.Format != "loopwork-native-activation-v1" || activation.CutoverID != uuidToString(id) || activation.ScopeHash != input.Scope || activation.WorkspaceHash != input.Workspace || activation.ExecutionStarted {
		writeError(w, 409, "only the original unused activation can be deactivated")
		return
	}
	for _, project := range row.ProjectIds {
		if _, err = q.LockEngineeringHistoryAdoptionProject(ctx, db.LockEngineeringHistoryAdoptionProjectParams{ID: project, WorkspaceID: workspace}); err != nil {
			h.historyPreparationError(w, err)
			return
		}
	}
	activity, err := q.HasEngineeringHistoryExecution(ctx, row.ProjectIds)
	if err != nil || !activity.Valid || activity.Bool {
		writeError(w, 409, "native execution or ownership history requires explicit reconciliation")
		return
	}
	adopted, err := q.ListEngineeringHistoryAdoptions(ctx, db.ListEngineeringHistoryAdoptionsParams{CutoverID: id, WorkspaceID: workspace})
	if err != nil || len(adopted) != len(activation.Tasks) {
		writeError(w, 409, "activated task correspondence changed")
		return
	}
	issues, err := q.ListEngineeringHistoryProjectIssues(ctx, db.ListEngineeringHistoryProjectIssuesParams{WorkspaceID: workspace, Column2: row.ProjectIds})
	if err != nil || len(issues) != len(adopted) {
		writeError(w, 409, "native project has missing or additional tasks")
		return
	}
	native := map[string]db.Issue{}
	for _, issue := range issues {
		native[uuidToString(issue.ID)] = issue
	}
	receipt := historyDeactivationReceipt{Format: "loopwork-native-deactivation-v1", CutoverID: uuidToString(id), ScopeHash: input.Scope, WorkspaceHash: input.Workspace, DeactivatedBy: localUserID, DeactivatedAt: time.Now().UTC().Format(time.RFC3339Nano), Activation: row.Activation, Tasks: []map[string]any{}, Resources: activation.Resources}
	for _, adoption := range adopted {
		issue, found := native[uuidToString(adoption.IssueID)]
		var original historyAdoptionPayload
		if !found || adoption.Phase != "activated" || issue.Status != "backlog" || json.Unmarshal(adoption.Payload, &original) != nil {
			writeError(w, 409, "changed native task requires reconciliation")
			return
		}
		matched := false
		for _, saved := range activation.Tasks {
			if saved["issue_id"] == uuidToString(adoption.IssueID) && saved["preparation_id"] == uuidToString(adoption.PreparationID) && saved["source_task_id"] == adoption.SourceTaskID {
				matched = true
			}
		}
		snapshot, snapshotErr := q.LockEngineeringHistoryIssueSnapshot(ctx, db.LockEngineeringHistoryIssueSnapshotParams{ID: issue.ID, WorkspaceID: workspace})
		if !matched || snapshotErr != nil || !unchangedActivatedHistoryIssue(original.NativeIssue, snapshot) {
			writeError(w, 409, "review the changed native task before deactivation")
			return
		}
		actor := map[string]string{"kind": "human", "workspaceId": localWorkspaceID, "userId": localUserID, "issueId": uuidToString(issue.ID)}
		overview, loadErr := h.EngineeringWorker.Call(ctx, map[string]any{"action": "overview", "actor": actor})
		var state struct {
			Configured *bool `json:"configured"`
		}
		if loadErr != nil || json.Unmarshal(overview, &state) != nil || state.Configured == nil || *state.Configured {
			writeError(w, 409, "existing business workflow requires reconciliation")
			return
		}
		binding, loadErr := h.EngineeringWorker.Call(ctx, map[string]any{"action": "team-binding", "actor": actor})
		var team struct {
			Binding json.RawMessage `json:"binding"`
		}
		if loadErr != nil || json.Unmarshal(binding, &team) != nil || string(team.Binding) != "null" {
			writeError(w, 409, "a started Team binding requires reconciliation")
			return
		}
		receipt.Tasks = append(receipt.Tasks, map[string]any{"issue_id": uuidToString(issue.ID), "preparation_id": uuidToString(adoption.PreparationID), "source_task_id": adoption.SourceTaskID, "native_issue": json.RawMessage(snapshot), "phase": "withdrawn"})
	}
	inspection, _, err := h.inspectHistoryWorkspaces(ctx, row, input.Workspace)
	if err != nil {
		h.historyPreparationError(w, err)
		return
	}
	receipt.SourceInspection = inspection
	resources, err := q.ListProjectResourcesForProjects(ctx, row.ProjectIds)
	if err != nil || len(resources) != len(activation.Resources) || len(resources) != len(row.ProjectIds) {
		writeError(w, 409, "native resources changed after activation")
		return
	}
	for _, saved := range activation.Resources {
		resourceID, idErr := util.ParseUUID(saved.ID)
		projectID, projectErr := util.ParseUUID(saved.ProjectID)
		if idErr != nil || projectErr != nil {
			writeError(w, 409, "activation resource identity is unavailable")
			return
		}
		if _, err = q.DeleteEngineeringHistoryActivationResource(ctx, db.DeleteEngineeringHistoryActivationResourceParams{ID: resourceID, WorkspaceID: workspace, ProjectID: projectID, ResourceRef: saved.Ref, CreatedBy: human}); err != nil {
			writeError(w, 409, "activation resource changed; retain it for reconciliation")
			return
		}
	}
	raw, _ := json.Marshal(receipt)
	if _, err = q.DeactivateEngineeringHistoryCutover(ctx, db.DeactivateEngineeringHistoryCutoverParams{ID: id, WorkspaceID: workspace, Deactivation: raw}); err != nil {
		h.historyPreparationError(w, err)
		return
	}
	published := []db.Issue{}
	for _, adoption := range adopted {
		if _, err = q.DeactivateEngineeringHistoryAdoption(ctx, db.DeactivateEngineeringHistoryAdoptionParams{CutoverID: id, WorkspaceID: workspace, SourceTaskID: adoption.SourceTaskID}); err != nil {
			h.historyPreparationError(w, err)
			return
		}
		issue, updateErr := q.CancelEngineeringHistoryDraft(ctx, db.CancelEngineeringHistoryDraftParams{ID: adoption.IssueID, WorkspaceID: workspace})
		if updateErr != nil {
			h.historyPreparationError(w, updateErr)
			return
		}
		published = append(published, issue)
	}
	if err = tx.Commit(ctx); err != nil {
		h.historyPreparationError(w, err)
		return
	}
	for _, issue := range published {
		if h.Bus != nil {
			h.Bus.Publish(events.Event{Type: protocol.EventIssueUpdated, WorkspaceID: localWorkspaceID, ActorType: "member", ActorID: localUserID, Payload: map[string]any{"issue": issueToResponse(issue, h.getIssuePrefix(ctx, workspace))}})
		}
	}
	writeJSON(w, 200, receipt)
}
