package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/engineering/ownership"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type engineeringReadinessObservation struct {
	Hash                  string  `json:"hash"`
	CaseID                string  `json:"case_id"`
	VerificationAttemptID string  `json:"verification_attempt_id"`
	TargetHash            string  `json:"target_hash"`
	PublicationHash       string  `json:"publication_hash"`
	WorkspaceID           string  `json:"workspace_id"`
	IssueID               string  `json:"issue_id"`
	ProjectID             string  `json:"project_id"`
	RuntimeID             string  `json:"runtime_id"`
	TaskID                *string `json:"task_id"`
	BusinessHash          string  `json:"business_hash"`
	SourceKey             string  `json:"source_key"`
	Readiness             string  `json:"readiness"`
	Reason                string  `json:"reason"`
	ObservedAt            int64   `json:"observed_at"`
}

func engineeringReadinessHash(p engineeringReadinessObservation) string {
	return engineeringHandoffFieldsHash("multica:repair-readiness:1", p.CaseID, p.VerificationAttemptID, p.TargetHash, p.PublicationHash, p.WorkspaceID, p.IssueID, p.ProjectID, p.RuntimeID, engineeringOptionalText(p.TaskID), p.BusinessHash, p.SourceKey, p.Readiness, p.Reason, strconv.FormatInt(p.ObservedAt, 10))
}

func (h *Handler) ReconcileEngineeringRecoveryReadiness(ctx context.Context, authority engineeringAdminAuthority) error {
	if h.EngineeringTakeoverControl == nil {
		return nil
	}
	raw, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-observing", "authority": authority})
	if err != nil {
		return err
	}
	var pending []struct {
		CaseID string `json:"case_id"`
	}
	if err = json.Unmarshal(raw, &pending); err != nil {
		return err
	}
	var failures []error
	for _, item := range pending {
		if _, err = h.EngineeringTakeoverControl.Call(ctx, map[string]any{"action": "observe-readiness", "authority": authority, "case_id": item.CaseID}); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

// Sampling is read-only. A due timer is not permission to surrender work or
// cancel processes; a later takeback capability still needs fresh source proof.
func (h *Handler) observeEngineeringRecoveryReadiness(ctx context.Context, raw json.RawMessage) (any, error) {
	var input engineeringPublicationRequest
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, err
	}
	initial, err := h.readEngineeringPublicationContext(ctx, input)
	if err != nil {
		return nil, err
	}
	observed, err := h.readEngineeringObservedPublication(ctx, input, initial)
	if err != nil {
		return nil, err
	}
	p := observed.Published.Publication
	r := observed.Current.Reservation
	value := engineeringReadinessObservation{CaseID: p.CaseID, VerificationAttemptID: p.VerificationAttemptID, TargetHash: p.TargetHash, PublicationHash: p.Hash, WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, ProjectID: r.ProjectID, RuntimeID: p.RuntimeID, Readiness: "waiting", Reason: "native-inspection-pending"}
	response, businessErr := h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "host", "workspaceId": p.WorkspaceID, "issueId": p.IssueID}, "action": "repair-dispatch-readiness", "payload": map[string]string{"target_hash": p.TargetHash, "application_hash": p.ApplicationHash, "ready_hash": p.ReadyHash}})
	var state struct {
		Hash            string  `json:"hash"`
		WorkspaceID     string  `json:"workspaceId"`
		IssueID         string  `json:"issueId"`
		TargetHash      string  `json:"target_hash"`
		ApplicationHash string  `json:"application_hash"`
		ReadyHash       string  `json:"ready_hash"`
		EntryTaskID     string  `json:"entry_task_id"`
		AgentID         string  `json:"agent_id"`
		UserID          string  `json:"user_id"`
		State           string  `json:"state"`
		Reason          string  `json:"reason"`
		TaskID          string  `json:"task_id"`
		DraftID         *string `json:"draft_id"`
		Revision        int     `json:"revision"`
		Sequence        int     `json:"sequence"`
	}
	if businessErr != nil || json.Unmarshal(response, &state) != nil || len(state.Hash) != 64 || state.WorkspaceID != p.WorkspaceID || state.IssueID != p.IssueID || state.TargetHash != p.TargetHash || state.ApplicationHash != p.ApplicationHash || state.ReadyHash != p.ReadyHash || state.EntryTaskID != p.TaskID || state.AgentID != p.AgentID || state.UserID != p.UserID {
		value.Readiness = "source-changed"
		value.Reason = "business-source-unavailable"
		value.BusinessHash = engineeringHandoffFieldsHash(value.Reason)
	} else {
		value.BusinessHash = state.Hash
		switch state.State {
		case "paused":
			value.Readiness = "paused"
			value.Reason = state.Reason
		case "ended":
			value.Readiness = "ended"
			value.Reason = state.Reason
		case "waiting":
			value.Reason = state.Reason
		case "eligible":
			if err = h.classifyEngineeringRecoveryQueue(ctx, observed, state.TaskID, state.DraftID, state.Revision, state.Sequence, &value); err != nil {
				value.Readiness = "source-changed"
				value.Reason = "native-source-unavailable"
			}
		default:
			value.Readiness = "source-changed"
			value.Reason = "unknown-business-readiness"
		}
	}
	value.SourceKey = engineeringHandoffFieldsHash("multica:repair-dispatch-source:1", p.Hash, value.BusinessHash, engineeringOptionalText(value.TaskID), value.SourceKey)
	value.ObservedAt = time.Now().UnixMilli()
	value.Hash = engineeringReadinessHash(value)
	fresh, err := h.readEngineeringObservedPublication(ctx, input, initial)
	if err != nil {
		return nil, err
	}
	if fresh.Current.CurrentIntentRevision != observed.Current.CurrentIntentRevision || !engineeringSameJSON(fresh.Published, observed.Published) {
		return nil, fmt.Errorf("readiness authority changed before sampling")
	}
	return h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-watch", "authority": input.Authority, "case_id": input.CaseID, "payload": value})
}

func (h *Handler) classifyEngineeringRecoveryQueue(ctx context.Context, observed *engineeringObservedPublication, currentTask string, draftID *string, revision, sequence int, value *engineeringReadinessObservation) error {
	p, r := observed.Published.Publication, observed.Current.Reservation
	if revision != r.Continuation.ExpectedRevision || engineeringOptionalText(draftID) != engineeringOptionalText(observed.Application.DraftID) {
		return fmt.Errorf("business readiness changed its prepared stage")
	}
	workspace, err := util.ParseUUID(p.WorkspaceID)
	if err != nil {
		return err
	}
	issueID, err := util.ParseUUID(p.IssueID)
	if err != nil {
		return err
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: workspace, ID: issueID})
	if err != nil {
		return err
	}
	if uuidToString(issue.ProjectID) != r.ProjectID {
		return fmt.Errorf("readiness project changed")
	}
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, workspace, issue.Status)
	if err != nil {
		return err
	}
	if issue.TriageState.Valid || category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed {
		value.Readiness = "ended"
		value.Reason = "native-issue-ended"
		return nil
	}
	if err := h.validateEngineeringRepairSuccessor(ctx, r.Continuation); err != nil {
		return err
	}
	runtimeID, err := util.ParseUUID(p.RuntimeID)
	if err != nil {
		return err
	}
	runtime, err := h.Queries.GetAgentRuntime(ctx, runtimeID)
	if err != nil {
		return err
	}
	agentID, err := util.ParseUUID(p.AgentID)
	if err != nil {
		return err
	}
	agent, err := h.Queries.GetAgent(ctx, agentID)
	if err != nil {
		return err
	}
	if agent.RuntimeID != runtime.ID || runtime.WorkspaceID != workspace || runtime.Visibility == "private" && runtime.OwnerID != agent.OwnerID {
		return fmt.Errorf("native role runtime ownership changed")
	}
	if _, err = h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: workspace, ProjectID: issue.ProjectID}); err == nil {
		value.Reason = "native-project-fence"
		return nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	reservations, err := h.Queries.ListEngineeringRepairHandoffReservations(ctx, db.ListEngineeringRepairHandoffReservationsParams{WorkspaceID: workspace, ProjectID: issue.ProjectID})
	if err != nil {
		return err
	}
	if len(reservations) > 0 {
		value.Reason = "native-project-reservation"
		return nil
	}
	tasks, err := h.Queries.ListTasksByIssue(ctx, issueID)
	if err != nil {
		return err
	}
	var current *db.AgentTaskQueue
	for i := range tasks {
		if uuidToString(tasks[i].ID) == currentTask {
			current = &tasks[i]
			break
		}
	}
	if current == nil || uuidToString(current.AgentID) != p.AgentID || uuidToString(current.RuntimeID) != p.RuntimeID || uuidToString(current.OriginatorUserID) != p.UserID {
		return fmt.Errorf("current recovery native task changed")
	}
	if current.Status == "running" || current.Status == "dispatched" {
		id := currentTask
		value.TaskID = &id
		value.Readiness = "executing"
		value.Reason = "native-execution-active"
		return nil
	}
	if current.Status == "waiting_local_directory" {
		value.Reason = "native-resource-wait"
		return nil
	}
	queued, err := h.Queries.ListQueuedClaimCandidatesByRuntime(ctx, runtimeID)
	if err != nil {
		return err
	}
	for _, candidate := range queued {
		if candidate.IssueID != issueID || candidate.AgentID != agentID || uuidToString(candidate.OriginatorUserID) != p.UserID {
			continue
		}
		if uuidToString(candidate.ID) != p.TaskID {
			hint, e := h.engineeringRecoveryForTask(ctx, candidate, p.WorkspaceID)
			if e != nil || hint == nil || hint.TargetHash != p.TargetHash || engineeringOptionalText(hint.DraftID) != engineeringOptionalText(draftID) || hint.Revision != revision || hint.Sequence > sequence {
				continue
			}
		}
		id := uuidToString(candidate.ID)
		value.TaskID = &id
		claim := ""
		if candidate.DispatchedAt.Valid {
			claim = strconv.FormatInt(candidate.DispatchedAt.Time.UnixMicro(), 10)
		}
		value.SourceKey = engineeringHandoffFieldsHash("multica:repair-native-dispatch-source:1", runtime.OwnerID.String(), runtime.DaemonID.String, runtime.Visibility, string(candidate.Context), claim)
		guards, e := h.Queries.ListEngineeringProjectControllers(ctx, db.ListEngineeringProjectControllersParams{WorkspaceID: workspace, ProjectID: issue.ProjectID})
		if e != nil {
			return e
		}
		for _, guard := range guards {
			if guard.ScopeKind.String != "issue" || guard.ScopeID != issueID {
				continue
			}
			processes, e := h.Queries.ListEngineeringRunProcesses(ctx, db.ListEngineeringRunProcessesParams{WorkspaceID: workspace, ControllerID: guard.ControllerID})
			if e != nil {
				return e
			}
			if guard.Phase != "quiesced" || !ownership.ControllerCleanupConfirmed(guard, processes) {
				value.Reason = "native-controller-cleanup-pending"
				return nil
			}
		}
		if h.TaskService == nil {
			return fmt.Errorf("native queue inspection unavailable")
		}
		readiness, e := h.TaskService.InspectEngineeringDispatch(ctx, candidate, time.Now())
		if e != nil {
			return e
		}
		value.Reason = readiness.Reason
		if readiness.Runnable {
			value.Readiness = "runnable"
		}
		return nil
	}
	for _, other := range tasks {
		if other.Status != "completed" && other.Status != "failed" && other.Status != "cancelled" {
			value.Reason = "native-retry-or-unlinked-work-wait"
			return nil
		}
	}
	if current.Status == "failed" || current.Status == "completed" {
		value.Readiness = "failed"
		value.Reason = "native-terminal-without-dispatch"
	} else {
		value.Readiness = "ended"
		value.Reason = "native-execution-ended"
	}
	return nil
}
