package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type engineeringRecoveryCheckpoint struct {
	Hash                  string  `json:"hash"`
	CaseID                string  `json:"case_id"`
	VerificationAttemptID string  `json:"verification_attempt_id"`
	TargetHash            string  `json:"target_hash"`
	ApplicationHash       string  `json:"application_hash"`
	ReadyHash             string  `json:"ready_hash"`
	EntryTaskID           string  `json:"entry_task_id"`
	TaskID                string  `json:"task_id"`
	AttemptID             string  `json:"attempt_id"`
	ExecutionHintHash     *string `json:"execution_hint_hash"`
	WorkspaceID           string  `json:"workspace_id"`
	IssueID               string  `json:"issue_id"`
	AgentID               string  `json:"agent_id"`
	UserID                string  `json:"user_id"`
	RuntimeID             string  `json:"runtime_id"`
	ProjectID             string  `json:"project_id"`
	DraftID               *string `json:"draft_id"`
	Revision              int     `json:"revision"`
	Sequence              int     `json:"sequence"`
}
type engineeringRecoveryFault struct {
	Hash                  string  `json:"hash"`
	CaseID                string  `json:"case_id"`
	VerificationAttemptID string  `json:"verification_attempt_id"`
	TargetHash            string  `json:"target_hash"`
	ApplicationHash       string  `json:"application_hash"`
	ReadyHash             string  `json:"ready_hash"`
	PublicationHash       string  `json:"publication_hash"`
	EntryTaskID           string  `json:"entry_task_id"`
	TaskID                string  `json:"task_id"`
	AttemptID             string  `json:"attempt_id"`
	ExecutionHintHash     *string `json:"execution_hint_hash"`
	WorkspaceID           string  `json:"workspace_id"`
	IssueID               string  `json:"issue_id"`
	ProjectID             string  `json:"project_id"`
	RuntimeID             string  `json:"runtime_id"`
	AgentID               string  `json:"agent_id"`
	UserID                string  `json:"user_id"`
	CheckpointHash        string  `json:"checkpoint_hash"`
	Status                string  `json:"status"`
	CompletedAt           string  `json:"completed_at"`
	FailureReason         *string `json:"failure_reason"`
	ContextHash           string  `json:"context_hash"`
}

func engineeringRecoveryFaultHash(p engineeringRecoveryFault) string {
	return engineeringHandoffFieldsHash("multica:repair-recovery-fault:1", p.CaseID, p.VerificationAttemptID, p.TargetHash, p.ApplicationHash, p.ReadyHash, p.PublicationHash, p.EntryTaskID, p.TaskID, p.AttemptID, engineeringOptionalText(p.ExecutionHintHash), p.WorkspaceID, p.IssueID, p.ProjectID, p.RuntimeID, p.AgentID, p.UserID, p.CheckpointHash, p.Status, p.CompletedAt, engineeringOptionalText(p.FailureReason), p.ContextHash)
}

// Failure observation holds business first. Existing outbox delivery reopens the
// same Case; takeover still acquires a native fence before any cancellation.
func (h *Handler) observeEngineeringRecoveryFailure(ctx context.Context, input engineeringPublicationRequest, initial engineeringHandoffContext) (any, error) {
	observed, err := h.readEngineeringObservedPublication(ctx, input, initial)
	if err != nil {
		return nil, err
	}
	p, r := observed.Published.Publication, observed.Current.Reservation
	actor := map[string]string{"kind": "host", "workspaceId": p.WorkspaceID, "issueId": p.IssueID}
	pin := map[string]string{"target_hash": p.TargetHash, "application_hash": p.ApplicationHash, "ready_hash": p.ReadyHash}
	raw, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": actor, "action": "repair-recovery-checkpoint", "payload": pin})
	if err != nil {
		return nil, err
	}
	var state struct {
		Checkpoint *engineeringRecoveryCheckpoint `json:"checkpoint"`
		Held       json.RawMessage                `json:"held"`
	}
	if err = json.Unmarshal(raw, &state); err != nil {
		return nil, err
	}
	if len(state.Held) > 0 && string(state.Held) != "null" {
		var record engineeringRepairObservation
		if json.Unmarshal(state.Held, &record) != nil || record.Recovery == nil || record.Recovery.CaseID != p.CaseID || record.Recovery.TargetHash != p.TargetHash {
			return nil, fmt.Errorf("replayed recovery hold has no matching immutable fault")
		}
		if err = h.deliverEngineeringRepairObservation(ctx, input.Authority, state.Held); err != nil {
			return nil, err
		}
		return map[string]bool{"closed": false, "held": true}, nil
	}
	c := state.Checkpoint
	if c == nil {
		return map[string]bool{"closed": false}, nil
	}
	if len(c.Hash) != 64 || c.CaseID != p.CaseID || c.VerificationAttemptID != p.VerificationAttemptID || c.TargetHash != p.TargetHash || c.ApplicationHash != p.ApplicationHash || c.ReadyHash != p.ReadyHash || c.EntryTaskID != p.TaskID || c.WorkspaceID != p.WorkspaceID || c.IssueID != p.IssueID || c.AgentID != p.AgentID || c.UserID != p.UserID || c.RuntimeID != p.RuntimeID || c.ProjectID != r.ProjectID || c.Sequence < r.Continuation.ExpectedSequence || c.Revision != r.Continuation.ExpectedRevision || engineeringOptionalText(c.DraftID) != engineeringOptionalText(observed.Application.DraftID) {
		return nil, fmt.Errorf("failed recovery checkpoint changed its native publication")
	}
	taskID, err := util.ParseUUID(c.TaskID)
	if err != nil {
		return nil, err
	}
	workspaceID, err := util.ParseUUID(p.WorkspaceID)
	if err != nil {
		return nil, err
	}
	projectID, err := util.ParseUUID(r.ProjectID)
	if err != nil {
		return nil, err
	}
	if h.TxStarter == nil {
		return nil, fmt.Errorf("recovery failure storage unavailable")
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	q := h.Queries.WithTx(tx)
	if _, err = q.LockEngineeringProjectAdmission(ctx, db.LockEngineeringProjectAdmissionParams{WorkspaceID: workspaceID, ProjectID: projectID}); err != nil {
		return nil, err
	}
	task, err := q.LockEngineeringNativeTask(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if uuidToString(task.IssueID) != p.IssueID || uuidToString(task.AgentID) != p.AgentID || uuidToString(task.RuntimeID) != p.RuntimeID || uuidToString(task.OriginatorUserID) != p.UserID || !task.DispatchedAt.Valid || c.AttemptID != c.TaskID+":"+strconv.FormatInt(task.DispatchedAt.Time.UnixMicro(), 10) {
		return nil, fmt.Errorf("failed recovery native claim changed")
	}
	if (task.Status != "failed" && task.Status != "completed") || !task.CompletedAt.Valid {
		return map[string]bool{"closed": false}, nil
	}
	if c.TaskID != p.TaskID {
		hint, e := h.engineeringRecoveryForTask(ctx, task, p.WorkspaceID)
		if e != nil {
			return nil, e
		}
		if hint == nil || hint.Hash != engineeringOptionalText(c.ExecutionHintHash) || hint.EntryTaskID != p.TaskID || hint.TargetHash != p.TargetHash || engineeringOptionalText(hint.DraftID) != engineeringOptionalText(c.DraftID) || hint.Revision != c.Revision {
			return nil, fmt.Errorf("failed execution has no native recovery context")
		}
	}
	issue, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: task.IssueID, WorkspaceID: workspaceID})
	if err != nil {
		return nil, err
	}
	category, err := issuestatus.CategoryWithError(ctx, q, workspaceID, issue.Status)
	if err != nil {
		return nil, err
	}
	if issue.ProjectID != projectID {
		return nil, fmt.Errorf("failed recovery project changed")
	}
	if issue.TriageState.Valid || category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed {
		return map[string]bool{"closed": false}, nil
	}
	if _, err = q.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: workspaceID, ProjectID: projectID}); err == nil {
		return map[string]bool{"closed": false}, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	reservations, err := q.ListEngineeringRepairHandoffReservations(ctx, db.ListEngineeringRepairHandoffReservationsParams{WorkspaceID: workspaceID, ProjectID: projectID})
	if err != nil {
		return nil, err
	}
	if len(reservations) > 0 {
		return map[string]bool{"closed": false}, nil
	}
	tasks, err := q.ListTasksByIssue(ctx, task.IssueID)
	if err != nil {
		return nil, err
	}
	for _, other := range tasks {
		if other.ID != task.ID && other.Status != "completed" && other.Status != "failed" && other.Status != "cancelled" {
			return map[string]bool{"closed": false}, nil
		}
	}
	fresh, err := h.readEngineeringObservedPublication(ctx, input, initial)
	if err != nil {
		return nil, err
	}
	if fresh.Current.CurrentIntentRevision != observed.Current.CurrentIntentRevision || !engineeringSameJSON(fresh.Published, observed.Published) {
		return nil, fmt.Errorf("recovery failure authority changed before business hold")
	}
	var reason *string
	if task.FailureReason.Valid && task.FailureReason.String != "" {
		value := task.FailureReason.String
		reason = &value
	}
	digest := sha256.Sum256(task.Context)
	fault := engineeringRecoveryFault{CaseID: p.CaseID, VerificationAttemptID: p.VerificationAttemptID, TargetHash: p.TargetHash, ApplicationHash: p.ApplicationHash, ReadyHash: p.ReadyHash, PublicationHash: p.Hash, EntryTaskID: p.TaskID, TaskID: c.TaskID, AttemptID: c.AttemptID, ExecutionHintHash: c.ExecutionHintHash, WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, ProjectID: r.ProjectID, RuntimeID: p.RuntimeID, AgentID: p.AgentID, UserID: p.UserID, CheckpointHash: c.Hash, Status: task.Status, CompletedAt: task.CompletedAt.Time.UTC().Format(time.RFC3339Nano), FailureReason: reason, ContextHash: hex.EncodeToString(digest[:])}
	fault.Hash = engineeringRecoveryFaultHash(fault)
	if h.EngineeringHostVersion == "" {
		return nil, fmt.Errorf("recovery observation requires the current native host version")
	}
	raw, err = h.EngineeringWorker.Call(ctx, map[string]any{"actor": actor, "action": "repair-recovery-hold", "host_version": h.EngineeringHostVersion, "payload": map[string]any{"target_hash": p.TargetHash, "application_hash": p.ApplicationHash, "ready_hash": p.ReadyHash, "native": fault}})
	if err != nil {
		return nil, err
	}
	var held struct {
		Held json.RawMessage `json:"held"`
	}
	if err = json.Unmarshal(raw, &held); err != nil {
		return nil, err
	}
	if len(held.Held) == 0 || string(held.Held) == "null" {
		return nil, fmt.Errorf("recovery failure did not persist its business hold")
	}
	var record engineeringRepairObservation
	if json.Unmarshal(held.Held, &record) != nil || record.Recovery == nil || record.Recovery.Hash != fault.Hash {
		return nil, fmt.Errorf("persisted recovery hold differs from its native fault")
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	if err = h.deliverEngineeringRepairObservation(ctx, input.Authority, held.Held); err != nil {
		return nil, err
	}
	return map[string]bool{"closed": false, "held": true}, nil
}

func (h *Handler) validateEngineeringRecoveryFaultSource(ctx context.Context, observation engineeringRepairObservation, source db.AgentTaskQueue, issue db.Issue) error {
	f := observation.Recovery
	if f == nil {
		return nil
	}
	if engineeringRecoveryFaultHash(*f) != f.Hash || f.WorkspaceID != observation.WorkspaceID || f.IssueID != observation.IssueID || f.AgentID != observation.AgentID || f.AttemptID != observation.AttemptID || f.TaskID != uuidToString(source.ID) || f.ProjectID != uuidToString(issue.ProjectID) || f.RuntimeID != uuidToString(source.RuntimeID) || f.UserID != uuidToString(source.OriginatorUserID) {
		return fmt.Errorf("recovery fault changed its frozen native source")
	}
	row, err := h.Queries.GetEngineeringRepairPublication(ctx, f.TargetHash)
	if err != nil {
		return err
	}
	var published engineeringHandoffPublished
	if json.Unmarshal([]byte(row.Payload), &published) != nil {
		return fmt.Errorf("invalid recovery fault publication")
	}
	p := published.Publication
	if !p.Published || p.Hash != engineeringHandoffPublicationHash(p) || p.Hash != f.PublicationHash || p.CaseID != f.CaseID || p.VerificationAttemptID != f.VerificationAttemptID || p.TargetHash != f.TargetHash || p.ApplicationHash != f.ApplicationHash || p.ReadyHash != f.ReadyHash || p.TaskID != f.EntryTaskID || uuidToString(row.TaskID) != f.EntryTaskID || uuidToString(row.ProjectID) != f.ProjectID || uuidToString(row.WorkspaceID) != f.WorkspaceID || p.WorkspaceID != f.WorkspaceID || p.IssueID != f.IssueID || p.AgentID != f.AgentID || p.UserID != f.UserID || p.RuntimeID != f.RuntimeID {
		return fmt.Errorf("recovery fault cannot move to another published Case")
	}
	return nil
}
