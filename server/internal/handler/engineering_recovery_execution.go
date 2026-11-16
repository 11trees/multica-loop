package handler

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func engineeringEntryRecoveryHint(ready engineeringHandoffReady, draftID *string) service.EngineeringRecoveryExecution {
	c := ready.Continuation
	h := service.EngineeringRecoveryExecution{Kind: "entry", TargetHash: ready.TargetHash, ApplicationHash: ready.ApplicationHash, ReadyHash: ready.Hash, EntryTaskID: c.TaskID, WorkspaceID: c.WorkspaceID, IssueID: c.IssueID, AgentID: c.AgentID, UserID: c.UserID, DraftID: draftID, Revision: c.ExpectedRevision, Sequence: c.ExpectedSequence}
	h.Hash = h.Digest()
	return h
}
func validateEngineeringRecoverySelection(hint *service.EngineeringRecoveryExecution, c engineeringContinuation) error {
	if err := hint.Validate(); err != nil {
		return err
	}
	if hint.Kind != "continuation" || hint.WorkspaceID != c.WorkspaceID || hint.IssueID != c.IssueID || hint.AgentID != c.AgentID || hint.UserID != c.UserID || hint.Revision != c.ExpectedRevision || hint.Sequence != c.ExpectedSequence {
		return fmt.Errorf("recovery continuation changed its selected checkpoint")
	}
	return nil
}

// The hint is loaded from native persisted task context. The caller has already
// authenticated this task's actual runtime and current dispatched claim.
func (h *Handler) engineeringRecoveryForTask(ctx context.Context, task db.AgentTaskQueue, workspaceID string) (*service.EngineeringRecoveryExecution, error) {
	hint, err := service.EngineeringRecoveryFromContext(task.Context)
	if err != nil || hint == nil {
		return hint, err
	}
	row, err := h.Queries.GetEngineeringRepairPublication(ctx, hint.TargetHash)
	if err != nil {
		return nil, err
	}
	var published engineeringHandoffPublished
	if json.Unmarshal([]byte(row.Payload), &published) != nil {
		return nil, fmt.Errorf("invalid native recovery publication")
	}
	p, r := published.Publication, published.Ready
	if !p.Published || p.Hash != engineeringHandoffPublicationHash(p) || r.Hash != engineeringHandoffReadyHash(r) || p.TargetHash != hint.TargetHash || p.ApplicationHash != hint.ApplicationHash || p.ReadyHash != hint.ReadyHash || r.ApplicationHash != hint.ApplicationHash || p.ReadyHash != r.Hash || r.TargetHash != hint.TargetHash || p.TaskID != hint.EntryTaskID || r.Continuation.TaskID != hint.EntryTaskID || uuidToString(row.TaskID) != hint.EntryTaskID || uuidToString(row.WorkspaceID) != workspaceID || p.WorkspaceID != workspaceID || hint.WorkspaceID != workspaceID || p.IssueID != hint.IssueID || uuidToString(task.IssueID) != hint.IssueID || p.AgentID != hint.AgentID || uuidToString(task.AgentID) != hint.AgentID || p.UserID != hint.UserID || uuidToString(task.OriginatorUserID) != hint.UserID || p.RuntimeID != uuidToString(task.RuntimeID) || hint.Revision != r.Continuation.ExpectedRevision || hint.Sequence < r.Continuation.ExpectedSequence {
		return nil, fmt.Errorf("native recovery execution changed its publication scope")
	}
	if hint.Kind == "entry" {
		if hint.Sequence != r.Continuation.ExpectedSequence {
			return nil, fmt.Errorf("entry recovery checkpoint changed")
		}
		// A copied entry context is valid only on its official native retry or
		// rerun descendants, with identical scope at every hop.
		current := task
		seen := map[string]bool{}
		for uuidToString(current.ID) != hint.EntryTaskID {
			id := uuidToString(current.ID)
			if seen[id] || len(seen) >= 64 {
				return nil, fmt.Errorf("invalid native recovery retry lineage")
			}
			seen[id] = true
			parent := current.RetryOfTaskID
			if !parent.Valid {
				parent = current.RerunOfTaskID
			}
			if !parent.Valid {
				return nil, fmt.Errorf("entry recovery context has no native parent")
			}
			current, err = h.Queries.GetAgentTask(ctx, parent)
			if err != nil {
				return nil, err
			}
			if current.IssueID != task.IssueID || current.AgentID != task.AgentID || current.RuntimeID != task.RuntimeID || current.OriginatorUserID != task.OriginatorUserID {
				return nil, fmt.Errorf("native recovery retry scope changed")
			}
		}
	}
	return hint, nil
}
