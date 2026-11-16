package handler

import (
	"context"
	"encoding/json"
	"fmt"
)

// Invoked only by the independent host, behind the attempt's private command
// socket. The provider cannot supply a path, version receipt or accepted targets.
func (h *Handler) PrepareEngineeringRepairVerification(ctx context.Context, claim json.RawMessage) error {
	if h.EngineeringTakeoverControl == nil {
		return fmt.Errorf("native repair ownership control is unavailable")
	}
	raw, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "takeover-current", "claim": claim})
	if err != nil {
		return err
	}
	var current engineeringTakeoverCurrent
	if err = json.Unmarshal(raw, &current); err != nil {
		return err
	}
	progress, err := h.EngineeringTakeoverControl.Call(ctx, map[string]any{"claim": claim})
	if err != nil {
		return err
	}
	var physical engineeringRepairProgress
	if err = json.Unmarshal(progress, &physical); err != nil {
		return err
	}
	if physical.Phase != "owned" || physical.WorkspaceRoot == nil {
		return fmt.Errorf("independent verification requires confirmed repair ownership")
	}
	if _, err = h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "takeover-progress", "claim": claim, "payload": progress}); err != nil {
		return err
	}
	source := current.Request
	if err = h.recordEngineeringRepairWorkspaceVersion(ctx, claim, source.WorkspaceID, source.IssueID, source.CaseID, source.ObservationID, source.SnapshotHash, progress); err != nil {
		return err
	}
	_, err = h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "verification-prepare", "claim": claim})
	return err
}
