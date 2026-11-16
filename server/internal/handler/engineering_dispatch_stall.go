package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const engineeringDispatchHoldKey = "engineering_dispatch_hold"

type engineeringDispatchStall struct {
	Hash                  string                         `json:"hash"`
	CaseID                string                         `json:"case_id"`
	VerificationAttemptID string                         `json:"verification_attempt_id"`
	TargetHash            string                         `json:"target_hash"`
	ApplicationHash       string                         `json:"application_hash"`
	ReadyHash             string                         `json:"ready_hash"`
	PublicationHash       string                         `json:"publication_hash"`
	TaskID                string                         `json:"task_id"`
	WorkspaceID           string                         `json:"workspace_id"`
	IssueID               string                         `json:"issue_id"`
	ProjectID             string                         `json:"project_id"`
	RuntimeID             string                         `json:"runtime_id"`
	AgentID               string                         `json:"agent_id"`
	UserID                string                         `json:"user_id"`
	CheckpointHash        string                         `json:"checkpoint_hash"`
	Preparation           engineeringRecoveryPreparation `json:"preparation"`
	WatchHash             string                         `json:"watch_hash"`
	SourceKey             string                         `json:"source_key"`
	EligibleElapsedMS     int64                          `json:"eligible_elapsed_ms"`
	IntentRevision        int64                          `json:"intent_revision"`
	ObservedAt            int64                          `json:"observed_at"`
	ReservedAt            string                         `json:"reserved_at"`
	TaskCreatedAt         string                         `json:"task_created_at"`
	ContextHash           string                         `json:"context_hash"`
	Status                string                         `json:"status"`
	ClaimedAt             *string                        `json:"claimed_at"`
	StartedAt             *string                        `json:"started_at"`
}

func engineeringDispatchStallHash(p engineeringDispatchStall) string {
	return engineeringHandoffFieldsHash("multica:repair-dispatch-stall:1", p.CaseID, p.VerificationAttemptID, p.TargetHash, p.ApplicationHash, p.ReadyHash, p.PublicationHash, p.TaskID, p.WorkspaceID, p.IssueID, p.ProjectID, p.RuntimeID, p.AgentID, p.UserID, p.CheckpointHash, p.Preparation.ObservationID, p.Preparation.ReceiptHash, p.Preparation.SourceAttemptID, p.Preparation.BindingsHash, p.WatchHash, p.SourceKey, strconv.FormatInt(p.EligibleElapsedMS, 10), strconv.FormatInt(p.IntentRevision, 10), strconv.FormatInt(p.ObservedAt, 10), p.ReservedAt, p.TaskCreatedAt, p.ContextHash, p.Status)
}
func engineeringDispatchContext(task db.AgentTaskQueue) (map[string]json.RawMessage, string, error) {
	values := map[string]json.RawMessage{}
	if len(task.Context) > 0 && string(task.Context) != "null" {
		if err := json.Unmarshal(task.Context, &values); err != nil {
			return nil, "", err
		}
	}
	delete(values, engineeringDispatchHoldKey)
	raw, err := json.Marshal(values)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(raw)
	return values, hex.EncodeToString(sum[:]), nil
}
func engineeringDispatchMarker(task db.AgentTaskQueue) (*engineeringDispatchStall, error) {
	var value map[string]json.RawMessage
	if len(task.Context) == 0 {
		return nil, nil
	}
	if err := json.Unmarshal(task.Context, &value); err != nil {
		return nil, err
	}
	raw, ok := value[engineeringDispatchHoldKey]
	if !ok {
		return nil, nil
	}
	var receipt engineeringDispatchStall
	if json.Unmarshal(raw, &receipt) != nil || receipt.Hash != engineeringDispatchStallHash(receipt) || receipt.Status != "queued" || receipt.ClaimedAt != nil || receipt.StartedAt != nil || receipt.EligibleElapsedMS < 20*60*1000 {
		return nil, fmt.Errorf("invalid native dispatch hold")
	}
	return &receipt, nil
}
func (h *Handler) dispatchStallTask(ctx context.Context, p engineeringHandoffPublication) (db.AgentTaskQueue, *engineeringDispatchStall, error) {
	id, err := util.ParseUUID(p.TaskID)
	if err != nil {
		return db.AgentTaskQueue{}, nil, err
	}
	task, err := h.Queries.GetAgentTask(ctx, id)
	if err != nil {
		return task, nil, err
	}
	receipt, err := engineeringDispatchMarker(task)
	return task, receipt, err
}
func (h *Handler) validateEngineeringDispatchStall(ctx context.Context, p engineeringDispatchStall, task db.AgentTaskQueue) error {
	_, contextHash, err := engineeringDispatchContext(task)
	if err != nil {
		return err
	}
	marker, err := engineeringDispatchMarker(task)
	if err != nil {
		return err
	}
	if marker == nil || marker.Hash != p.Hash || task.DispatchedAt.Valid || task.StartedAt.Valid || (task.Status != "queued" && task.Status != "cancelled") || uuidToString(task.ID) != p.TaskID || uuidToString(task.IssueID) != p.IssueID || uuidToString(task.AgentID) != p.AgentID || uuidToString(task.RuntimeID) != p.RuntimeID || uuidToString(task.OriginatorUserID) != p.UserID || !task.CreatedAt.Valid || task.CreatedAt.Time.UTC().Format(time.RFC3339Nano) != p.TaskCreatedAt || contextHash != p.ContextHash {
		return fmt.Errorf("native dispatch hold source changed")
	}
	row, err := h.Queries.GetEngineeringRepairPublication(ctx, p.TargetHash)
	if err != nil {
		return err
	}
	var published engineeringHandoffPublished
	if json.Unmarshal([]byte(row.Payload), &published) != nil {
		return fmt.Errorf("invalid held publication")
	}
	v := published.Publication
	if !v.Published || v.TargetHash != p.TargetHash || uuidToString(row.TaskID) != p.TaskID || v.Hash != engineeringHandoffPublicationHash(v) || v.Hash != p.PublicationHash || v.CaseID != p.CaseID || v.VerificationAttemptID != p.VerificationAttemptID || v.TaskID != p.TaskID || v.ApplicationHash != p.ApplicationHash || v.ReadyHash != p.ReadyHash || v.WorkspaceID != p.WorkspaceID || v.IssueID != p.IssueID || v.RuntimeID != p.RuntimeID || v.AgentID != p.AgentID || v.UserID != p.UserID || uuidToString(row.ProjectID) != p.ProjectID || uuidToString(row.WorkspaceID) != p.WorkspaceID {
		return fmt.Errorf("dispatch hold publication changed")
	}
	return nil
}

// A persisted marker is a queue barrier, not physical ownership or cancellation.
func (h *Handler) holdEngineeringDispatchStall(ctx context.Context, input engineeringPublicationRequest, observed *engineeringObservedPublication, proof *engineeringDispatchStall) (any, error) {
	p := observed.Published.Publication
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
		var held engineeringRepairObservation
		if json.Unmarshal(state.Held, &held) != nil || held.DispatchStall == nil || proof == nil || held.DispatchStall.Hash != proof.Hash {
			return nil, fmt.Errorf("dispatch outbox changed")
		}
		if err = h.deliverEngineeringRepairObservation(ctx, input.Authority, state.Held); err != nil {
			return nil, err
		}
		return map[string]bool{"held": true}, nil
	}
	c := state.Checkpoint
	if c == nil || c.Preparation == nil || c.AttemptID != "" || c.TaskID != p.TaskID {
		return map[string]bool{"held": false}, nil
	}
	if c.CaseID != p.CaseID || c.VerificationAttemptID != p.VerificationAttemptID || c.TargetHash != p.TargetHash || c.ApplicationHash != p.ApplicationHash || c.ReadyHash != p.ReadyHash || c.EntryTaskID != p.TaskID || c.AgentID != p.AgentID || c.UserID != p.UserID || c.WorkspaceID != p.WorkspaceID || c.IssueID != p.IssueID || c.RuntimeID != p.RuntimeID || c.ProjectID != observed.Current.Reservation.ProjectID || c.Revision != observed.Current.Reservation.Continuation.ExpectedRevision || c.Sequence != observed.Current.Reservation.Continuation.ExpectedSequence || engineeringOptionalText(c.DraftID) != engineeringOptionalText(observed.Application.DraftID) {
		return nil, fmt.Errorf("prepared dispatch checkpoint changed")
	}
	if proof == nil {
		var watch struct {
			Due         bool                            `json:"stall_due"`
			Observation engineeringReadinessObservation `json:"observation"`
			Watch       struct {
				IntentRevision int64  `json:"intentRevision"`
				SourceKey      string `json:"sourceKey"`
				ElapsedMS      int64  `json:"eligibleElapsedMs"`
			} `json:"watch"`
		}
		raw, err = h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-watch-read", "authority": input.Authority, "case_id": p.CaseID})
		if err != nil {
			return nil, err
		}
		if json.Unmarshal(raw, &watch) != nil || !watch.Due || watch.Watch.ElapsedMS < 20*60*1000 || watch.Watch.IntentRevision != observed.Current.CurrentIntentRevision || watch.Observation.Hash != engineeringReadinessHash(watch.Observation) || watch.Observation.Readiness != "runnable" || engineeringOptionalText(watch.Observation.TaskID) != p.TaskID || watch.Watch.SourceKey != watch.Observation.SourceKey {
			return map[string]bool{"held": false}, nil
		}
		if h.TxStarter == nil {
			return nil, fmt.Errorf("dispatch hold storage unavailable")
		}
		tx, e := h.TxStarter.Begin(ctx)
		if e != nil {
			return nil, e
		}
		defer tx.Rollback(ctx)
		q := h.Queries.WithTx(tx)
		workspace, e := util.ParseUUID(p.WorkspaceID)
		if e != nil {
			return nil, e
		}
		project, e := util.ParseUUID(c.ProjectID)
		if e != nil {
			return nil, e
		}
		taskID, e := util.ParseUUID(p.TaskID)
		if e != nil {
			return nil, e
		}
		if _, e = q.LockEngineeringProjectAdmission(ctx, db.LockEngineeringProjectAdmissionParams{WorkspaceID: workspace, ProjectID: project}); e != nil {
			return nil, e
		}
		task, e := q.LockEngineeringNativeTask(ctx, taskID)
		if e != nil {
			return nil, e
		}
		if task.Status != "queued" || task.DispatchedAt.Valid || task.StartedAt.Valid {
			return map[string]bool{"held": false}, nil
		}
		existing, e := engineeringDispatchMarker(task)
		if e != nil {
			return nil, e
		}
		if existing != nil {
			return nil, fmt.Errorf("dispatch reservation changed during creation")
		}
		raw, e = h.EngineeringWorker.Call(ctx, map[string]any{"actor": actor, "action": "repair-dispatch-readiness", "payload": pin})
		if e != nil {
			return nil, e
		}
		var business struct {
			Hash  string `json:"hash"`
			State string `json:"state"`
		}
		if json.Unmarshal(raw, &business) != nil || business.State != "eligible" || business.Hash != watch.Observation.BusinessHash {
			return map[string]bool{"held": false}, nil
		}
		freshSample := watch.Observation
		freshSample.Readiness = "waiting"
		freshSample.SourceKey = ""
		freshSample.TaskID = nil
		if e = h.classifyEngineeringRecoveryQueue(ctx, observed, c.TaskID, c.DraftID, c.Revision, c.Sequence, &freshSample); e != nil {
			return nil, e
		}
		freshSample.SourceKey = engineeringHandoffFieldsHash("multica:repair-dispatch-source:1", p.Hash, business.Hash, engineeringOptionalText(freshSample.TaskID), freshSample.SourceKey)
		if freshSample.Readiness != "runnable" || freshSample.SourceKey != watch.Observation.SourceKey {
			return map[string]bool{"held": false}, nil
		}
		current, e := h.readEngineeringObservedPublication(ctx, input, observed.Current)
		if e != nil {
			return nil, e
		}
		if current.Current.CurrentIntentRevision != observed.Current.CurrentIntentRevision || !engineeringSameJSON(current.Published, observed.Published) {
			return nil, fmt.Errorf("dispatch hold authority changed")
		}
		_, contextHash, e := engineeringDispatchContext(task)
		if e != nil {
			return nil, e
		}
		receipt := engineeringDispatchStall{CaseID: p.CaseID, VerificationAttemptID: p.VerificationAttemptID, TargetHash: p.TargetHash, ApplicationHash: p.ApplicationHash, ReadyHash: p.ReadyHash, PublicationHash: p.Hash, TaskID: p.TaskID, WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, ProjectID: c.ProjectID, RuntimeID: p.RuntimeID, AgentID: p.AgentID, UserID: p.UserID, CheckpointHash: c.Hash, Preparation: *c.Preparation, WatchHash: watch.Observation.Hash, SourceKey: watch.Observation.SourceKey, EligibleElapsedMS: watch.Watch.ElapsedMS, IntentRevision: watch.Watch.IntentRevision, ObservedAt: watch.Observation.ObservedAt, ReservedAt: time.Now().UTC().Format(time.RFC3339Nano), TaskCreatedAt: task.CreatedAt.Time.UTC().Format(time.RFC3339Nano), ContextHash: contextHash, Status: "queued"}
		receipt.Hash = engineeringDispatchStallHash(receipt)
		encoded, _ := json.Marshal(receipt)
		if _, e = q.ReserveEngineeringDispatchHold(ctx, db.ReserveEngineeringDispatchHoldParams{TaskID: taskID, Receipt: encoded, ExpectedContext: task.Context}); e != nil {
			return nil, e
		}
		if e = tx.Commit(ctx); e != nil {
			return nil, e
		}
		proof = &receipt
	}
	task, _, err := h.dispatchStallTask(ctx, p)
	if err != nil {
		return nil, err
	}
	if err = h.validateEngineeringDispatchStall(ctx, *proof, task); err != nil {
		return nil, err
	}
	if proof.CheckpointHash != c.Hash || !engineeringSameJSON(proof.Preparation, *c.Preparation) {
		return nil, fmt.Errorf("reserved dispatch checkpoint changed")
	}
	current, err := h.readEngineeringObservedPublication(ctx, input, observed.Current)
	if err != nil {
		return nil, err
	}
	if !engineeringSameJSON(current.Published, observed.Published) {
		return nil, fmt.Errorf("reserved dispatch publication changed")
	}
	if h.EngineeringHostVersion == "" {
		return nil, fmt.Errorf("dispatch hold requires native host version")
	}
	raw, err = h.EngineeringWorker.Call(ctx, map[string]any{"actor": actor, "action": "repair-dispatch-hold", "host_version": h.EngineeringHostVersion, "payload": map[string]any{"target_hash": p.TargetHash, "application_hash": p.ApplicationHash, "ready_hash": p.ReadyHash, "native": proof}})
	if err != nil {
		return nil, err
	}
	var held struct {
		Held json.RawMessage `json:"held"`
	}
	if json.Unmarshal(raw, &held) != nil || len(held.Held) == 0 {
		return nil, fmt.Errorf("dispatch hold has no business outbox")
	}
	var record engineeringRepairObservation
	if json.Unmarshal(held.Held, &record) != nil || record.DispatchStall == nil || record.DispatchStall.Hash != proof.Hash {
		return nil, fmt.Errorf("business dispatch hold changed")
	}
	if err = h.deliverEngineeringRepairObservation(ctx, input.Authority, held.Held); err != nil {
		return nil, err
	}
	return map[string]bool{"held": true}, nil
}

func (h *Handler) validateEngineeringDispatchSource(ctx context.Context, source engineeringTakeoverSource) error {
	if source.DispatchHoldHash == nil && source.DispatchTaskID == nil {
		return nil
	}
	if source.DispatchHoldHash == nil || source.DispatchTaskID == nil {
		return fmt.Errorf("incomplete dispatch source")
	}
	id, err := util.ParseUUID(*source.DispatchTaskID)
	if err != nil {
		return err
	}
	task, err := h.Queries.GetAgentTask(ctx, id)
	if err != nil {
		return err
	}
	proof, err := engineeringDispatchMarker(task)
	if err != nil {
		return err
	}
	if proof == nil || proof.Hash != *source.DispatchHoldHash || proof.CaseID != source.CaseID || proof.WorkspaceID != source.WorkspaceID || proof.IssueID != source.IssueID || proof.AgentID != source.AgentID || proof.Preparation.SourceAttemptID != source.AttemptID {
		return fmt.Errorf("dispatch source changed its queued task or anchor")
	}
	return h.validateEngineeringDispatchStall(ctx, *proof, task)
}
