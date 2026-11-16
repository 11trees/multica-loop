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

type engineeringHandoffFence struct {
	AttemptID        string `json:"attempt_id"`
	Generation       int64  `json:"generation"`
	OwnerID          string `json:"owner_id"`
	SupervisionToken int64  `json:"supervision_token"`
	IntentRevision   int64  `json:"intent_revision"`
	ObservationID    string `json:"observation_id"`
	SourceAttemptID  string `json:"source_attempt_id"`
	SourceRevision   int64  `json:"source_revision"`
	SnapshotHash     string `json:"snapshot_hash"`
	WorkspacePath    string `json:"workspace_path"`
	TargetsHash      string `json:"targets_hash"`
}
type engineeringHandoffReservation struct {
	Reserved              bool                    `json:"reserved"`
	Hash                  string                  `json:"hash"`
	CaseID                string                  `json:"case_id"`
	VerificationAttemptID string                  `json:"verification_attempt_id"`
	TargetHash            string                  `json:"target_hash"`
	PreparationHash       string                  `json:"preparation_hash"`
	ProjectID             string                  `json:"project_id"`
	ExpectedVersion       string                  `json:"expected_version"`
	Continuation          engineeringContinuation `json:"continuation"`
	Fence                 engineeringHandoffFence `json:"fence"`
}

func engineeringHandoffReservationHash(value engineeringHandoffReservation) string {
	c, f := value.Continuation, value.Fence
	fields := []string{"multica:repair-handoff-reservation:1", value.CaseID, value.VerificationAttemptID, value.TargetHash, value.PreparationHash, value.ProjectID, value.ExpectedVersion,
		c.WorkspaceID, c.IssueID, c.AgentID, c.UserID, c.TaskID, c.ParentIssueID, strconv.Itoa(c.ExpectedRevision), strconv.Itoa(c.ExpectedSequence), c.Reason,
		f.AttemptID, strconv.FormatInt(f.Generation, 10), f.OwnerID, strconv.FormatInt(f.SupervisionToken, 10), strconv.FormatInt(f.IntentRevision, 10), f.ObservationID, f.SourceAttemptID, strconv.FormatInt(f.SourceRevision, 10), f.SnapshotHash, f.WorkspacePath, f.TargetsHash}
	digest := sha256.New()
	for _, field := range fields {
		_, _ = fmt.Fprintf(digest, "%d:%s", len(field), field)
	}
	return hex.EncodeToString(digest.Sum(nil))
}

// The native reservation commits before any business checkpoint can be enabled.
// It is an admission barrier and an immutable identity, not a runnable task.
func (h *Handler) reserveEngineeringRepairHandoff(ctx context.Context, initial engineeringHandoffContext, pin db.CreateEngineeringRepairFenceParams, prepared engineeringHandoffPreparation, validate func() error) (engineeringHandoffReservation, error) {
	var result engineeringHandoffReservation
	if h.TxStarter == nil {
		return result, fmt.Errorf("handoff transactions unavailable")
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	q := h.Queries.WithTx(tx)
	if _, err = q.LockEngineeringProject(ctx, db.LockEngineeringProjectParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID}); err != nil {
		return result, err
	}
	fence, err := q.LockEngineeringRepairFence(ctx, db.LockEngineeringRepairFenceParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
	if err != nil {
		return result, err
	}
	if !engineeringFenceMatches(fence, pin) || fence.Phase != "owned" {
		return result, fmt.Errorf("handoff reservation lost native fence")
	}
	var target struct {
		VerificationAttemptID string `json:"verificationAttemptId"`
		ExpectedVersion       string `json:"expectedVersion"`
		Binding               struct {
			TargetsHash string `json:"targetsHash"`
		} `json:"workspaceBinding"`
	}
	if err = json.Unmarshal(initial.Target, &target); err != nil {
		return result, err
	}
	if target.VerificationAttemptID == "" {
		return result, fmt.Errorf("handoff verification identity is missing")
	}
	var inventory engineeringRepairTargets
	if err = json.Unmarshal(fence.Targets, &inventory); err != nil {
		return result, err
	}
	encoded, err := json.Marshal(inventory)
	if err != nil {
		return result, err
	}
	digest := sha256.Sum256(encoded)
	if hex.EncodeToString(digest[:]) != target.Binding.TargetsHash {
		return result, fmt.Errorf("handoff reservation writer inventory changed")
	}
	active, err := q.ListEngineeringProjectActiveTasks(ctx, db.ListEngineeringProjectActiveTasksParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
	if err != nil {
		return result, err
	}
	if len(active) != 0 {
		return result, fmt.Errorf("handoff reservation has unfinished native work")
	}
	writers, err := q.ListEngineeringProjectWriterTasks(ctx, db.ListEngineeringProjectWriterTasksParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
	if err != nil {
		return result, err
	}
	known := map[string]bool{}
	for _, task := range inventory.Tasks {
		known[engineeringTaskTargetKey(task.ID, task.RuntimeID, task.Claim)] = true
	}
	for _, task := range writers {
		claim := int64(0)
		if task.DispatchedAt.Valid {
			claim = task.DispatchedAt.Time.UnixMicro()
		}
		if !known[engineeringTaskTargetKey(uuidToString(task.ID), uuidToString(task.RuntimeID), claim)] {
			return result, fmt.Errorf("handoff reservation found a new native writer")
		}
	}
	if err = validate(); err != nil {
		return result, err
	}
	item := prepared.Continuation
	taskID, err := util.ParseUUID(item.TaskID)
	if err != nil {
		return result, err
	}
	if _, err = q.GetAgentTask(ctx, taskID); err == nil {
		return result, fmt.Errorf("handoff successor task already exists")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	result = engineeringHandoffReservation{Reserved: true, CaseID: pin.CaseID, VerificationAttemptID: target.VerificationAttemptID, TargetHash: initial.TargetHash, PreparationHash: prepared.Hash, ProjectID: uuidToString(pin.ProjectID), ExpectedVersion: target.ExpectedVersion, Continuation: item,
		Fence: engineeringHandoffFence{AttemptID: fence.AttemptID, Generation: fence.Generation, OwnerID: fence.OwnerID, SupervisionToken: fence.SupervisionToken, IntentRevision: fence.IntentRevision, ObservationID: fence.ObservationID, SourceAttemptID: fence.SourceAttemptID, SourceRevision: fence.SourceRevision, SnapshotHash: fence.SnapshotHash, WorkspacePath: fence.WorkspacePath, TargetsHash: target.Binding.TargetsHash}}
	result.Hash = engineeringHandoffReservationHash(result)
	payload, err := json.Marshal(result)
	if err != nil {
		return result, err
	}
	reservations, err := q.ListEngineeringRepairHandoffReservations(ctx, db.ListEngineeringRepairHandoffReservationsParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
	if err != nil {
		return result, err
	}
	for _, saved := range reservations {
		if saved.TargetHash != result.TargetHash {
			return result, fmt.Errorf("project already has another reserved handoff")
		}
	}
	saved, err := q.GetEngineeringRepairHandoff(ctx, result.TargetHash)
	if errors.Is(err, pgx.ErrNoRows) {
		saved, err = q.CreateEngineeringRepairHandoffReservation(ctx, db.CreateEngineeringRepairHandoffReservationParams{TargetHash: result.TargetHash, WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID, TaskID: taskID, Payload: string(payload)})
	}
	if err != nil {
		return result, err
	}
	if saved.WorkspaceID != pin.WorkspaceID || saved.ProjectID != pin.ProjectID || saved.TaskID != taskID || saved.Phase != "reserved" || saved.Payload != string(payload) {
		return result, fmt.Errorf("native handoff reservation cannot be replaced")
	}
	// Revalidate management intent after all native reads, immediately before commit.
	if err = validate(); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
