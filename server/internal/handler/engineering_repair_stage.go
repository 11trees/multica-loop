package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type engineeringHandoffApplication struct {
	Staged          bool                    `json:"staged"`
	HoldRetained    bool                    `json:"hold_retained"`
	Hash            string                  `json:"hash"`
	TargetHash      string                  `json:"target_hash"`
	PreparationHash string                  `json:"preparation_hash"`
	ReservationHash string                  `json:"reservation_hash"`
	ExpectedVersion string                  `json:"expected_version"`
	Continuation    engineeringContinuation `json:"continuation"`
	DraftID         *string                 `json:"draft_id"`
}

func engineeringSameJSON(a, b any) bool {
	left, e := json.Marshal(a)
	if e != nil {
		return false
	}
	right, e := json.Marshal(b)
	return e == nil && string(left) == string(right)
}

// Stage only the persisted native successor. Admission and the business hold
// stay closed until a separate native publication transaction is available.
func (h *Handler) stageEngineeringRepairHandoff(ctx context.Context, raw json.RawMessage) (any, error) {
	var input struct {
		Authority engineeringAdminAuthority `json:"authority"`
		CaseID    string                    `json:"case_id"`
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, err
	}
	read := func() (engineeringHandoffContext, error) {
		var c engineeringHandoffContext
		data, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-context", "authority": input.Authority, "case_id": input.CaseID})
		if err == nil {
			err = json.Unmarshal(data, &c)
		}
		if err == nil && (c.Request.CaseID != input.CaseID || c.Reservation == nil || c.Preparation == nil || c.CurrentIntentRevision < 1) {
			err = fmt.Errorf("business staging requires acknowledged native reservation")
		}
		return c, err
	}
	initial, err := read()
	if err != nil {
		return nil, err
	}
	r := initial.Reservation
	pin, err := h.engineeringSourceForCurrent(ctx, initial.engineeringTakeoverCurrent)
	if err != nil {
		return nil, err
	}
	validate := func() error {
		c, err := read()
		if err != nil {
			return err
		}
		if c.TargetHash != initial.TargetHash || c.CurrentIntentRevision != initial.CurrentIntentRevision || !engineeringSameJSON(c.Reservation, r) || !engineeringSameHandoffPreparation(c.Preparation, initial.Preparation) {
			return fmt.Errorf("staged recovery authority or immutable reservation changed")
		}
		fresh, err := h.engineeringSourceForCurrent(ctx, c.engineeringTakeoverCurrent)
		if err != nil {
			return err
		}
		if fresh != pin {
			return fmt.Errorf("staged recovery source changed")
		}
		saved, err := h.Queries.GetEngineeringRepairHandoff(ctx, c.TargetHash)
		if err != nil {
			return err
		}
		encoded, _ := json.Marshal(r)
		taskID, err := util.ParseUUID(r.Continuation.TaskID)
		if err != nil {
			return err
		}
		if _, err = h.Queries.GetAgentTask(ctx, taskID); err == nil {
			return fmt.Errorf("staged successor task already exists")
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if !r.Reserved || engineeringHandoffReservationHash(*r) != r.Hash || r.TargetHash != c.TargetHash || r.PreparationHash != c.Preparation.Hash || !engineeringSameJSON(r.Continuation, c.Preparation.Continuation) || saved.WorkspaceID != pin.WorkspaceID || saved.ProjectID != pin.ProjectID || saved.TaskID != taskID || saved.Phase != "reserved" || saved.Payload != string(encoded) {
			return fmt.Errorf("business staging does not own the persisted native successor")
		}
		fence, err := h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
		if err != nil {
			return err
		}
		if !engineeringFenceMatches(fence, pin) || fence.Phase != "owned" {
			return fmt.Errorf("business staging lost its exact native fence")
		}
		var inventory engineeringRepairTargets
		if err = json.Unmarshal(fence.Targets, &inventory); err != nil {
			return err
		}
		data, _ := json.Marshal(inventory)
		digest := sha256.Sum256(data)
		if hex.EncodeToString(digest[:]) != r.Fence.TargetsHash {
			return fmt.Errorf("business staging writer cohort changed")
		}
		active, err := h.Queries.ListEngineeringProjectActiveTasks(ctx, db.ListEngineeringProjectActiveTasksParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
		if err != nil {
			return err
		}
		if len(active) > 0 {
			return fmt.Errorf("business staging has unfinished native work")
		}
		writers, err := h.Queries.ListEngineeringProjectWriterTasks(ctx, db.ListEngineeringProjectWriterTasksParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
		if err != nil {
			return err
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
				return fmt.Errorf("business staging found a new native writer")
			}
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
	var targets engineeringRepairTargets
	if err = json.Unmarshal(fence.Targets, &targets); err != nil {
		return nil, err
	}
	drain := func() error {
		p, err := h.finishEngineeringPhysicalDrain(ctx, fence, targets, 0, validate)
		if err != nil {
			return err
		}
		if p.Phase != "owned" || p.TargetsHash != r.Fence.TargetsHash {
			return fmt.Errorf("business staging no longer owns its physical cohort")
		}
		return nil
	}
	if err = drain(); err != nil {
		return nil, err
	}
	actor := map[string]string{"kind": "host", "workspaceId": initial.Request.WorkspaceID, "issueId": initial.Request.IssueID}
	checkVersion := func() error {
		data, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-workspace-version", "actor": actor, "payload": map[string]string{"case_id": input.CaseID, "observation_id": initial.Request.ObservationID, "snapshot_hash": initial.Request.SnapshotHash}})
		if err != nil {
			return err
		}
		var v struct {
			Version string `json:"workspace_version"`
		}
		if json.Unmarshal(data, &v) != nil || v.Version != r.ExpectedVersion {
			return fmt.Errorf("staged repair content changed")
		}
		return nil
	}
	if err = checkVersion(); err != nil {
		return nil, err
	}
	applied, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-handoff-stage", "actor": actor, "payload": r})
	if err != nil {
		return nil, err
	}
	var result engineeringHandoffApplication
	if err = json.Unmarshal(applied, &result); err != nil {
		return nil, err
	}
	if !result.Staged || !result.HoldRetained || len(result.Hash) != 64 || result.TargetHash != r.TargetHash || result.PreparationHash != r.PreparationHash || result.ReservationHash != r.Hash || result.ExpectedVersion != r.ExpectedVersion || !engineeringSameJSON(result.Continuation, r.Continuation) || !engineeringSameJSON(result.DraftID, initial.Preparation.DraftID) {
		return nil, fmt.Errorf("business staging applied another successor or released its hold")
	}
	if err = drain(); err != nil {
		return nil, err
	}
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-source", "actor": actor, "payload": map[string]string{"case_id": input.CaseID, "observation_id": initial.Request.ObservationID, "snapshot_hash": initial.Request.SnapshotHash}})
	if err != nil {
		return nil, err
	}
	var lineage struct {
		State           string `json:"checkpoint_state"`
		TargetHash      string `json:"handoff_target_hash"`
		ApplicationHash string `json:"handoff_application_hash"`
	}
	if json.Unmarshal(data, &lineage) != nil || lineage.State != "staged" || lineage.TargetHash != r.TargetHash || lineage.ApplicationHash != result.Hash {
		return nil, fmt.Errorf("business staging has no exact applied lineage")
	}
	if err = checkVersion(); err != nil {
		return nil, err
	}
	if err = validate(); err != nil {
		return nil, err
	}
	return h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-staged", "authority": input.Authority, "case_id": input.CaseID, "payload": json.RawMessage(applied)})
}
