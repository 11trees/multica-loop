package handler

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/multica-ai/multica/server/internal/engineering/processidentity"
)

// The private socket projects the claim. Agent input never selects a project,
// repository path, content version, physical identity or accepted native receipt.
func (h *Handler) PrepareEngineeringRepairWorkspace(ctx context.Context, claim, request json.RawMessage) (json.RawMessage, error) {
	var command struct {
		Action string `json:"action"`
		Reason string `json:"reason"`
		Key    string `json:"key"`
	}
	if err := json.Unmarshal(request, &command); err != nil {
		return nil, err
	}
	if command.Action != "workspace-write" && command.Action != "workspace-candidate" {
		return nil, fmt.Errorf("unknown repair workspace action")
	}
	if h.EngineeringTakeoverControl == nil {
		return nil, fmt.Errorf("native repair workspace control unavailable")
	}
	raw, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "takeover-current", "claim": claim})
	if err != nil {
		return nil, err
	}
	var current struct {
		Request struct {
			WorkspaceID   string `json:"workspace_id"`
			IssueID       string `json:"issue_id"`
			CaseID        string `json:"case_id"`
			ObservationID string `json:"observation_id"`
			SnapshotHash  string `json:"snapshot_hash"`
		} `json:"request"`
		Attempt struct {
			PID    int    `json:"pid"`
			Marker string `json:"startMarker"`
		} `json:"attempt"`
	}
	if err = json.Unmarshal(raw, &current); err != nil {
		return nil, err
	}
	checkProcess := func() error {
		actual, e := processidentity.Marker(current.Attempt.PID)
		if e != nil || actual != current.Attempt.Marker || current.Attempt.Marker == "" || processidentity.ValidateGroup(current.Attempt.PID) != nil {
			return fmt.Errorf("repair workspace requires the actual bound investigator group")
		}
		return nil
	}
	if err = checkProcess(); err != nil {
		return nil, err
	}
	progress, err := h.EngineeringTakeoverControl.Call(ctx, map[string]any{"claim": claim})
	if err != nil {
		return nil, err
	}
	var owned engineeringRepairProgress
	if err = json.Unmarshal(progress, &owned); err != nil {
		return nil, err
	}
	if owned.Phase != "owned" || owned.WorkspaceRoot == nil {
		return nil, fmt.Errorf("repair workspace is still draining")
	}
	if _, err = h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "takeover-progress", "claim": claim, "payload": progress}); err != nil {
		return nil, err
	}
	source := current.Request
	if err = h.recordEngineeringRepairWorkspaceVersion(ctx, claim, source.WorkspaceID, source.IssueID, source.CaseID, source.ObservationID, source.SnapshotHash, progress); err != nil {
		return nil, err
	}
	if err = checkProcess(); err != nil {
		return nil, err
	}
	payload := map[string]any{"claim": claim}
	if command.Action == "workspace-write" {
		payload["action"] = "repair-write-authorize"
		payload["reason"] = command.Reason
	} else {
		payload["action"] = "repair-candidate-record"
		payload["key"] = command.Key
	}
	return h.EngineeringAdminWorker.Call(ctx, payload)
}
