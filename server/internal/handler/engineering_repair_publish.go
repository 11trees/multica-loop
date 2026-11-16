package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type engineeringHandoffReady struct {
	Ready           bool                    `json:"ready"`
	TargetHash      string                  `json:"target_hash"`
	ReservationHash string                  `json:"reservation_hash"`
	ApplicationHash string                  `json:"application_hash"`
	ExpectedVersion string                  `json:"expected_version"`
	Continuation    engineeringContinuation `json:"continuation"`
	Hash            string                  `json:"hash"`
}
type engineeringHandoffPublication struct {
	Published             bool   `json:"published"`
	Hash                  string `json:"hash"`
	CaseID                string `json:"case_id"`
	VerificationAttemptID string `json:"verification_attempt_id"`
	TargetHash            string `json:"target_hash"`
	ReservationHash       string `json:"reservation_hash"`
	ApplicationHash       string `json:"application_hash"`
	ReadyHash             string `json:"ready_hash"`
	TaskID                string `json:"task_id"`
	WorkspaceID           string `json:"workspace_id"`
	IssueID               string `json:"issue_id"`
	AgentID               string `json:"agent_id"`
	UserID                string `json:"user_id"`
	RuntimeID             string `json:"runtime_id"`
}
type engineeringHandoffPublished struct {
	Ready       engineeringHandoffReady       `json:"ready"`
	Publication engineeringHandoffPublication `json:"publication"`
}

func engineeringHandoffFieldsHash(fields ...string) string {
	h := sha256.New()
	for _, field := range fields {
		_, _ = fmt.Fprintf(h, "%d:%s", len(field), field)
	}
	return hex.EncodeToString(h.Sum(nil))
}
func engineeringHandoffReadyHash(r engineeringHandoffReady) string {
	c := r.Continuation
	return engineeringHandoffFieldsHash("multica:repair-dispatch-ready:1", r.TargetHash, r.ReservationHash, r.ApplicationHash, r.ExpectedVersion, c.WorkspaceID, c.IssueID, c.AgentID, c.UserID, c.TaskID, c.ParentIssueID, strconv.Itoa(c.ExpectedRevision), strconv.Itoa(c.ExpectedSequence), c.Reason)
}
func engineeringHandoffPublicationHash(p engineeringHandoffPublication) string {
	return engineeringHandoffFieldsHash("multica:repair-handoff-publication:1", p.CaseID, p.VerificationAttemptID, p.TargetHash, p.ReservationHash, p.ApplicationHash, p.ReadyHash, p.TaskID, p.WorkspaceID, p.IssueID, p.AgentID, p.UserID, p.RuntimeID)
}

type engineeringPublicationRequest struct {
	Authority engineeringAdminAuthority `json:"authority"`
	CaseID    string                    `json:"case_id"`
}

func (h *Handler) readEngineeringPublicationContext(ctx context.Context, input engineeringPublicationRequest) (engineeringHandoffContext, error) {
	var c engineeringHandoffContext
	raw, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-context", "authority": input.Authority, "case_id": input.CaseID})
	if err == nil {
		err = json.Unmarshal(raw, &c)
	}
	if err == nil && (c.Request.CaseID != input.CaseID || c.CurrentIntentRevision < 1 || len(c.TargetHash) != 64) {
		err = fmt.Errorf("invalid verified publication context")
	}
	return c, err
}
func (h *Handler) engineeringRepairPublicationStatus(ctx context.Context, raw json.RawMessage) (any, error) {
	var input engineeringPublicationRequest
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, err
	}
	c, err := h.readEngineeringPublicationContext(ctx, input)
	if err != nil {
		return nil, err
	}
	_, err = h.Queries.GetEngineeringRepairPublication(ctx, c.TargetHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return map[string]bool{"published": false}, nil
	}
	if err != nil {
		return nil, err
	}
	return map[string]bool{"published": true}, nil
}
func validateEngineeringHandoffReady(r engineeringHandoffReady, c engineeringHandoffContext, a engineeringHandoffApplication) error {
	if c.Reservation == nil || !r.Ready || engineeringHandoffReadyHash(r) != r.Hash || r.TargetHash != c.TargetHash || r.ReservationHash != c.Reservation.Hash || r.ApplicationHash != a.Hash || r.ExpectedVersion != c.Reservation.ExpectedVersion || !engineeringSameJSON(r.Continuation, c.Reservation.Continuation) {
		return fmt.Errorf("business dispatch readiness changed its reserved source")
	}
	return nil
}
func (h *Handler) acknowledgeEngineeringPublication(ctx context.Context, input engineeringPublicationRequest, c engineeringHandoffContext, row db.EngineeringRepairPublication, notify bool) (any, error) {
	var value engineeringHandoffPublished
	var a engineeringHandoffApplication
	if json.Unmarshal([]byte(row.Payload), &value) != nil || json.Unmarshal(c.Application, &a) != nil {
		return nil, fmt.Errorf("invalid native publication receipt")
	}
	if err := validateEngineeringHandoffReady(value.Ready, c, a); err != nil {
		return nil, err
	}
	p := value.Publication
	r := c.Reservation
	cont := value.Ready.Continuation
	if !p.Published || engineeringHandoffPublicationHash(p) != p.Hash || p.CaseID != input.CaseID || p.VerificationAttemptID != r.VerificationAttemptID || p.TargetHash != c.TargetHash || p.ReservationHash != r.Hash || p.ApplicationHash != a.Hash || p.ReadyHash != value.Ready.Hash || p.TaskID != cont.TaskID || p.WorkspaceID != cont.WorkspaceID || p.IssueID != cont.IssueID || p.AgentID != cont.AgentID || p.UserID != cont.UserID || p.RuntimeID != c.Request.Inspection.RuntimeID || uuidToString(row.TaskID) != p.TaskID || uuidToString(row.WorkspaceID) != p.WorkspaceID || uuidToString(row.ProjectID) != r.ProjectID {
		return nil, fmt.Errorf("native publication does not match the acknowledged business checkpoint")
	}
	taskID, err := util.ParseUUID(p.TaskID)
	if err != nil {
		return nil, err
	}
	task, err := h.Queries.GetAgentTask(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if uuidToString(task.IssueID) != p.IssueID || uuidToString(task.AgentID) != p.AgentID || uuidToString(task.RuntimeID) != p.RuntimeID || uuidToString(task.OriginatorUserID) != p.UserID {
		return nil, fmt.Errorf("published native task identity changed")
	}
	if notify && task.Status == "queued" && h.TaskService != nil {
		h.TaskService.NotifyEngineeringContinuation(ctx, task)
	}
	return h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-published", "authority": input.Authority, "case_id": input.CaseID, "payload": value})
}

// Readiness authorizes only this native task. Its row and ownership release
// become visible together; a lost acknowledgement never re-enqueues it.
func (h *Handler) publishEngineeringRepairHandoff(ctx context.Context, raw json.RawMessage) (any, error) {
	var input engineeringPublicationRequest
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, err
	}
	initial, err := h.readEngineeringPublicationContext(ctx, input)
	if err != nil {
		return nil, err
	}
	if prior, e := h.Queries.GetEngineeringRepairPublication(ctx, initial.TargetHash); e == nil {
		return h.acknowledgeEngineeringPublication(ctx, input, initial, prior, true)
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	var application engineeringHandoffApplication
	if initial.Reservation == nil || initial.Preparation == nil || json.Unmarshal(initial.Application, &application) != nil || !application.Staged || !application.HoldRetained || application.ReservationHash != initial.Reservation.Hash {
		return nil, fmt.Errorf("publication requires acknowledged business staging")
	}
	r := initial.Reservation
	pin, err := h.engineeringSourceForCurrent(ctx, initial.engineeringTakeoverCurrent)
	if err != nil {
		return nil, err
	}
	validate := func() error {
		c, err := h.readEngineeringPublicationContext(ctx, input)
		if err != nil {
			return err
		}
		if c.TargetHash != initial.TargetHash || c.CurrentIntentRevision != initial.CurrentIntentRevision || !engineeringSameJSON(c.Reservation, r) || !engineeringSameJSON(c.Application, initial.Application) {
			return fmt.Errorf("publication proof or current intent changed")
		}
		fresh, err := h.engineeringSourceForCurrent(ctx, c.engineeringTakeoverCurrent)
		if err != nil {
			return err
		}
		if fresh != pin {
			return fmt.Errorf("publication source changed")
		}
		saved, err := h.Queries.GetEngineeringRepairHandoff(ctx, c.TargetHash)
		if err != nil {
			return err
		}
		encoded, _ := json.Marshal(r)
		if saved.Phase != "reserved" || saved.Payload != string(encoded) || saved.WorkspaceID != pin.WorkspaceID || saved.ProjectID != pin.ProjectID {
			return fmt.Errorf("publication lost its native reservation")
		}
		f, err := h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
		if err != nil {
			return err
		}
		if !engineeringFenceMatches(f, pin) || f.Phase != "owned" {
			return fmt.Errorf("publication lost its exact owned fence")
		}
		return h.validateEngineeringRepairSuccessor(ctx, r.Continuation)
	}
	if err = validate(); err != nil {
		return nil, err
	}
	fence, err := h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
	if err != nil {
		return nil, err
	}
	var inventory engineeringRepairTargets
	if err = json.Unmarshal(fence.Targets, &inventory); err != nil {
		return nil, err
	}
	progress, err := h.finishEngineeringPhysicalDrain(ctx, fence, inventory, 0, validate)
	if err != nil {
		return nil, err
	}
	if progress.Phase != "owned" || progress.TargetsHash != r.Fence.TargetsHash {
		return nil, fmt.Errorf("publication physical ownership changed")
	}
	item := r.Continuation
	agentID, err := util.ParseUUID(item.AgentID)
	if err != nil {
		return nil, err
	}
	userID, err := util.ParseUUID(item.UserID)
	if err != nil {
		return nil, err
	}
	taskID, err := util.ParseUUID(item.TaskID)
	if err != nil {
		return nil, err
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: pin.WorkspaceID, ID: pin.IssueID})
	if err != nil {
		return nil, err
	}
	if h.TaskService == nil || h.TxStarter == nil {
		return nil, fmt.Errorf("native publication service unavailable")
	}
	plan, err := h.TaskService.PrepareEngineeringContinuation(ctx, issue, agentID, userID, taskID, "Continue the frozen Team workflow from its verified repair checkpoint.")
	if err != nil {
		return nil, err
	}
	if uuidToString(plan.Params.RuntimeID) != initial.Request.Inspection.RuntimeID {
		return nil, fmt.Errorf("publication runtime changed")
	}
	if plan.Params.OriginatorUserID != userID {
		return nil, fmt.Errorf("publication human attribution changed")
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	q := h.Queries.WithTx(tx)
	if _, err = q.LockEngineeringProject(ctx, db.LockEngineeringProjectParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID}); err != nil {
		return nil, err
	}
	if prior, e := q.GetEngineeringRepairPublication(ctx, initial.TargetHash); e == nil {
		if err = tx.Commit(ctx); err != nil {
			return nil, err
		}
		return h.acknowledgeEngineeringPublication(ctx, input, initial, prior, true)
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	locked, err := q.LockEngineeringRepairFence(ctx, db.LockEngineeringRepairFenceParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
	if err != nil {
		return nil, err
	}
	if !engineeringFenceMatches(locked, pin) || locked.Phase != "owned" {
		return nil, fmt.Errorf("publication ownership changed while waiting for admission")
	}
	if _, err = q.GetAgentTask(ctx, taskID); err == nil {
		return nil, fmt.Errorf("reserved successor already exists")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	active, err := q.ListEngineeringProjectActiveTasks(ctx, db.ListEngineeringProjectActiveTasksParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
	if err != nil {
		return nil, err
	}
	if len(active) > 0 {
		return nil, fmt.Errorf("publication has unfinished project tasks")
	}
	writers, err := q.ListEngineeringProjectWriterTasks(ctx, db.ListEngineeringProjectWriterTasksParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
	if err != nil {
		return nil, err
	}
	known := map[string]bool{}
	for _, target := range inventory.Tasks {
		known[engineeringTaskTargetKey(target.ID, target.RuntimeID, target.Claim)] = true
	}
	for _, task := range writers {
		claim := int64(0)
		if task.DispatchedAt.Valid {
			claim = task.DispatchedAt.Time.UnixMicro()
		}
		if !known[engineeringTaskTargetKey(uuidToString(task.ID), uuidToString(task.RuntimeID), claim)] {
			return nil, fmt.Errorf("publication writer cohort changed")
		}
	}
	if err = validate(); err != nil {
		return nil, err
	}
	actor := map[string]string{"kind": "host", "workspaceId": item.WorkspaceID, "issueId": item.IssueID}
	readyRaw, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-handoff-ready", "actor": actor, "payload": initial.Application})
	if err != nil {
		return nil, err
	}
	var ready engineeringHandoffReady
	if err = json.Unmarshal(readyRaw, &ready); err != nil {
		return nil, err
	}
	if err = validateEngineeringHandoffReady(ready, initial, application); err != nil {
		return nil, err
	}
	versionRaw, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-workspace-version", "actor": actor, "payload": map[string]string{"case_id": input.CaseID, "observation_id": pin.ObservationID, "snapshot_hash": pin.SnapshotHash}})
	if err != nil {
		return nil, err
	}
	var version struct {
		Value string `json:"workspace_version"`
	}
	if json.Unmarshal(versionRaw, &version) != nil || version.Value != r.ExpectedVersion {
		return nil, fmt.Errorf("publication actual candidate changed")
	}
	if err = validate(); err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(r)
	n, err := q.PublishEngineeringRepairReservation(ctx, db.PublishEngineeringRepairReservationParams{TargetHash: initial.TargetHash, WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID, Payload: string(encoded)})
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, fmt.Errorf("publication reservation changed")
	}
	n, err = q.ReleasePublishedEngineeringRepairFence(ctx, db.ReleasePublishedEngineeringRepairFenceParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID, CaseID: pin.CaseID, AttemptID: pin.AttemptID, Generation: pin.Generation, OwnerID: pin.OwnerID, SupervisionToken: pin.SupervisionToken, IntentRevision: pin.IntentRevision, ObservationID: pin.ObservationID, SourceAttemptID: pin.SourceAttemptID, SourceRevision: pin.SourceRevision, SnapshotHash: pin.SnapshotHash})
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, fmt.Errorf("publication fence changed")
	}
	hint := engineeringEntryRecoveryHint(ready, application.DraftID)
	plan.Params.EngineeringRecovery, err = json.Marshal(hint)
	if err != nil {
		return nil, err
	}
	task, err := q.CreateAgentTask(ctx, plan.Params)
	if err != nil {
		return nil, err
	}
	p := engineeringHandoffPublication{Published: true, CaseID: input.CaseID, VerificationAttemptID: r.VerificationAttemptID, TargetHash: initial.TargetHash, ReservationHash: r.Hash, ApplicationHash: application.Hash, ReadyHash: ready.Hash, TaskID: uuidToString(task.ID), WorkspaceID: item.WorkspaceID, IssueID: uuidToString(task.IssueID), AgentID: uuidToString(task.AgentID), UserID: uuidToString(task.OriginatorUserID), RuntimeID: uuidToString(task.RuntimeID)}
	p.Hash = engineeringHandoffPublicationHash(p)
	payload, _ := json.Marshal(engineeringHandoffPublished{Ready: ready, Publication: p})
	row, err := q.CreateEngineeringRepairPublication(ctx, db.CreateEngineeringRepairPublicationParams{TargetHash: initial.TargetHash, WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID, TaskID: task.ID, Payload: string(payload)})
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	h.TaskService.EngineeringContinuationPublished(ctx, plan, task)
	return h.acknowledgeEngineeringPublication(ctx, input, initial, row, false)
}
