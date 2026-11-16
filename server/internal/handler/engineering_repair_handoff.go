package handler

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/projectaccess"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type engineeringHandoffContext struct {
	engineeringTakeoverCurrent
	CurrentIntentRevision int64                          `json:"current_intent_revision"`
	Target                json.RawMessage                `json:"target"`
	TargetHash            string                         `json:"target_hash"`
	Preparation           *engineeringHandoffPreparation `json:"preparation"`
	Reservation           *engineeringHandoffReservation `json:"reservation"`
	Application           json.RawMessage                `json:"application"`
	Publication           *engineeringHandoffPublished   `json:"publication"`
}

type engineeringHandoffPreparation struct {
	Prepared     bool                    `json:"prepared"`
	Hash         string                  `json:"hash"`
	TargetHash   string                  `json:"target_hash"`
	Continuation engineeringContinuation `json:"continuation"`
	Kind         string                  `json:"kind"`
	DraftID      *string                 `json:"draft_id"`
}

func (h *Handler) controlEngineeringRepair(ctx context.Context, raw json.RawMessage) (any, error) {
	var request struct {
		Action string `json:"action"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, err
	}
	if request.Action == "" {
		return h.DrainEngineeringProject(ctx, raw)
	}
	switch request.Action {
	case "prepare-handoff":
		return h.prepareEngineeringRepairHandoff(ctx, raw)
	case "reserve-handoff":
		return h.runEngineeringRepairHandoff(ctx, raw, true)
	case "stage-handoff":
		return h.stageEngineeringRepairHandoff(ctx, raw)
	case "observe-readiness":
		return h.observeEngineeringRecoveryReadiness(ctx, raw)
	case "observe-handoff":
		return h.observeEngineeringRepairHandoff(ctx, raw)
	case "publication-status":
		return h.engineeringRepairPublicationStatus(ctx, raw)
	case "publish-handoff":
		return h.publishEngineeringRepairHandoff(ctx, raw)
	default:
		return nil, fmt.Errorf("unknown native repair control action")
	}
}

// The independent host prepares and reserves handoff; no Agent can supply a native
// scope, passing verdict, directory, continuation identity or fence release.
func (h *Handler) ReconcileEngineeringRepairHandoffs(ctx context.Context, authority engineeringAdminAuthority) error {
	if h.EngineeringTakeoverControl == nil {
		return nil
	}
	raw, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-pending", "authority": authority})
	if err != nil {
		return err
	}
	var pending []struct {
		CaseID string `json:"case_id"`
	}
	if err = json.Unmarshal(raw, &pending); err != nil {
		return err
	}
	for _, item := range pending {
		status, err := h.EngineeringTakeoverControl.Call(ctx, map[string]any{"action": "publication-status", "authority": authority, "case_id": item.CaseID})
		if err != nil {
			return err
		}
		var current struct {
			Published bool `json:"published"`
		}
		if err = json.Unmarshal(status, &current); err != nil {
			return err
		}
		if current.Published {
			if _, err = h.EngineeringTakeoverControl.Call(ctx, map[string]any{"action": "publish-handoff", "authority": authority, "case_id": item.CaseID}); err != nil {
				return err
			}
			continue
		}
		if _, err = h.EngineeringTakeoverControl.Call(ctx, map[string]any{"action": "prepare-handoff", "authority": authority, "case_id": item.CaseID}); err != nil {
			return err
		}
		if _, err = h.EngineeringTakeoverControl.Call(ctx, map[string]any{"action": "reserve-handoff", "authority": authority, "case_id": item.CaseID}); err != nil {
			return err
		}
		if _, err = h.EngineeringTakeoverControl.Call(ctx, map[string]any{"action": "stage-handoff", "authority": authority, "case_id": item.CaseID}); err != nil {
			return err
		}
		if _, err = h.EngineeringTakeoverControl.Call(ctx, map[string]any{"action": "publish-handoff", "authority": authority, "case_id": item.CaseID}); err != nil {
			return err
		}
	}
	return nil
}
func (h *Handler) prepareEngineeringRepairHandoff(ctx context.Context, raw json.RawMessage) (any, error) {
	return h.runEngineeringRepairHandoff(ctx, raw, false)
}
func (h *Handler) runEngineeringRepairHandoff(ctx context.Context, raw json.RawMessage, reserve bool) (any, error) {
	var input struct {
		Authority engineeringAdminAuthority `json:"authority"`
		CaseID    string                    `json:"case_id"`
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, err
	}
	read := func() (engineeringHandoffContext, error) {
		var current engineeringHandoffContext
		data, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-context", "authority": input.Authority, "case_id": input.CaseID})
		if err == nil {
			err = json.Unmarshal(data, &current)
		}
		if err == nil && (current.Request.CaseID != input.CaseID || len(current.TargetHash) != 64 || current.CurrentIntentRevision < 1) {
			err = fmt.Errorf("invalid verified handoff source")
		}
		return current, err
	}
	initial, err := read()
	if err != nil {
		return nil, err
	}
	if reserve && initial.Preparation == nil {
		return nil, fmt.Errorf("native reservation requires acknowledged handoff preparation")
	}
	pin, err := h.engineeringSourceForCurrent(ctx, initial.engineeringTakeoverCurrent)
	if err != nil {
		return nil, err
	}
	fence, err := h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
	if err != nil {
		return nil, err
	}
	if !engineeringFenceMatches(fence, pin) || fence.Phase != "owned" {
		return nil, fmt.Errorf("verified handoff does not own the exact project fence")
	}
	validate := func() error {
		current, err := read()
		if err != nil {
			return err
		}
		if current.TargetHash != initial.TargetHash || current.CurrentIntentRevision != initial.CurrentIntentRevision || (reserve && !engineeringSameHandoffPreparation(current.Preparation, initial.Preparation)) {
			return fmt.Errorf("handoff proof or intent changed")
		}
		fresh, err := h.engineeringSourceForCurrent(ctx, current.engineeringTakeoverCurrent)
		if err != nil {
			return err
		}
		saved, err := h.Queries.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: pin.WorkspaceID, ProjectID: pin.ProjectID})
		if err != nil {
			return err
		}
		if !engineeringFenceMatches(saved, fresh) || saved.Phase != "owned" {
			return fmt.Errorf("handoff native ownership changed")
		}
		return nil
	}
	var targets engineeringRepairTargets
	if err = json.Unmarshal(fence.Targets, &targets); err != nil {
		return nil, err
	}
	progress, err := h.finishEngineeringPhysicalDrain(ctx, fence, targets, 0, validate)
	if err != nil {
		return nil, err
	}
	var target struct {
		ExpectedVersion string `json:"expectedVersion"`
		Binding         struct {
			TargetsHash string `json:"targetsHash"`
		} `json:"workspaceBinding"`
	}
	if err = json.Unmarshal(initial.Target, &target); err != nil {
		return nil, err
	}
	if progress.Phase != "owned" || progress.TargetsHash != target.Binding.TargetsHash {
		return nil, fmt.Errorf("handoff writer cohort changed")
	}
	actor := map[string]string{"kind": "host", "workspaceId": initial.Request.WorkspaceID, "issueId": initial.Request.IssueID}
	prepared, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-handoff-prepare", "actor": actor, "payload": initial.Target})
	if err != nil {
		return nil, err
	}
	var result engineeringHandoffPreparation
	if err = json.Unmarshal(prepared, &result); err != nil {
		return nil, err
	}
	item := result.Continuation
	if !result.Prepared || len(result.Hash) != 64 || result.TargetHash != initial.TargetHash || item.Reason != "repair_ready" || item.WorkspaceID != initial.Request.WorkspaceID || item.IssueID != initial.Request.IssueID {
		return nil, fmt.Errorf("handoff prepared another native successor")
	}
	if err = h.validateEngineeringRepairSuccessor(ctx, item); err != nil {
		return nil, err
	}
	if reserve && !engineeringSameHandoffPreparation(initial.Preparation, &result) {
		return nil, fmt.Errorf("acknowledged handoff proposal changed")
	}
	finalize := func() error {
		version, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-workspace-version", "actor": actor, "payload": map[string]string{"case_id": input.CaseID, "observation_id": initial.Request.ObservationID, "snapshot_hash": initial.Request.SnapshotHash}})
		if err != nil {
			return err
		}
		var actual struct {
			Version string `json:"workspace_version"`
		}
		if json.Unmarshal(version, &actual) != nil || actual.Version != target.ExpectedVersion {
			return fmt.Errorf("handoff actual candidate changed after preparation")
		}
		if err = validate(); err != nil {
			return err
		}
		if err = h.validateEngineeringRepairSuccessor(ctx, item); err != nil {
			return err
		}
		return nil
	}
	if reserve {
		reservation, err := h.reserveEngineeringRepairHandoff(ctx, initial, pin, result, finalize)
		if err != nil {
			return nil, err
		}
		return h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-reserved", "authority": input.Authority, "case_id": input.CaseID, "payload": reservation})
	}
	if err = finalize(); err != nil {
		return nil, err
	}
	return h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-prepared", "authority": input.Authority, "case_id": input.CaseID, "payload": json.RawMessage(prepared)})
}

func engineeringSameHandoffPreparation(a, b *engineeringHandoffPreparation) bool {
	left, err := json.Marshal(a)
	if err != nil {
		return false
	}
	right, err := json.Marshal(b)
	return err == nil && string(left) == string(right)
}
func (h *Handler) validateEngineeringRepairSuccessor(ctx context.Context, item engineeringContinuation) error {
	if err := h.requireFrozenTeamContinuation(ctx, item); err != nil {
		return err
	}
	workspace, err := util.ParseUUID(item.WorkspaceID)
	if err != nil {
		return err
	}
	issueID, err := util.ParseUUID(item.IssueID)
	if err != nil {
		return err
	}
	user, err := util.ParseUUID(item.UserID)
	if err != nil {
		return err
	}
	agentID, err := util.ParseUUID(item.AgentID)
	if err != nil {
		return err
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: workspace, ID: issueID})
	if err != nil {
		return err
	}
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, workspace, issue.Status)
	if err != nil {
		return err
	}
	if issue.TriageState.Valid || category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed {
		return fmt.Errorf("handoff issue no longer admits execution")
	}
	member, err := h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: user, WorkspaceID: workspace})
	if err != nil {
		return err
	}
	access, err := projectaccess.ForMember(ctx, h.Queries, workspace, user, member.Role)
	if err != nil {
		return err
	}
	if !access.CanSeeProject(issue.ProjectID) {
		return fmt.Errorf("handoff human lost project access")
	}
	agent, err := h.Queries.GetAgent(ctx, agentID)
	if err != nil {
		return err
	}
	if agent.WorkspaceID != workspace || agent.ArchivedAt.Valid || !h.canInvokeAgent(ctx, agent, "member", item.UserID, item.UserID, item.WorkspaceID) {
		return fmt.Errorf("handoff role is no longer invocable")
	}
	_, err = h.engineeringExecutionResources(ctx, issue, agent)
	return err
}
