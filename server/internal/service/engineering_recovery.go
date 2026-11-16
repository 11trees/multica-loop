package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/google/uuid"
)

// EngineeringRecoveryExecution is host-prepared task context, never daemon
// request input. It links a normal continuation to the same repaired stage.
type EngineeringRecoveryExecution struct {
	Hash            string  `json:"hash"`
	Kind            string  `json:"kind"`
	TargetHash      string  `json:"target_hash"`
	ApplicationHash string  `json:"application_hash"`
	ReadyHash       string  `json:"ready_hash"`
	EntryTaskID     string  `json:"entry_task_id"`
	WorkspaceID     string  `json:"workspace_id"`
	IssueID         string  `json:"issue_id"`
	AgentID         string  `json:"agent_id"`
	UserID          string  `json:"user_id"`
	DraftID         *string `json:"draft_id"`
	Revision        int     `json:"revision"`
	Sequence        int     `json:"sequence"`
}

func (h EngineeringRecoveryExecution) Digest() string {
	draft := ""
	if h.DraftID != nil {
		draft = *h.DraftID
	}
	fields := []string{"multica:repair-execution-hint:1", h.Kind, h.TargetHash, h.ApplicationHash, h.ReadyHash, h.EntryTaskID, h.WorkspaceID, h.IssueID, h.AgentID, h.UserID, draft, strconv.Itoa(h.Revision), strconv.Itoa(h.Sequence)}
	d := sha256.New()
	for _, f := range fields {
		fmt.Fprintf(d, "%d:%s", len([]byte(f)), f)
	}
	return hex.EncodeToString(d.Sum(nil))
}
func (h EngineeringRecoveryExecution) Validate() error {
	for _, id := range []string{h.EntryTaskID, h.WorkspaceID, h.IssueID, h.AgentID, h.UserID} {
		if _, err := uuid.Parse(id); err != nil {
			return fmt.Errorf("invalid recovery execution identity")
		}
	}
	for _, digest := range []string{h.Hash, h.TargetHash, h.ApplicationHash, h.ReadyHash} {
		b, err := hex.DecodeString(digest)
		if err != nil || len(b) != 32 {
			return fmt.Errorf("invalid recovery execution digest")
		}
	}
	if (h.Kind != "entry" && h.Kind != "continuation") || h.Revision < 1 || h.Sequence < 0 || h.DraftID != nil && *h.DraftID == "" || h.Digest() != h.Hash {
		return fmt.Errorf("recovery execution hint changed")
	}
	return nil
}
func EngineeringRecoveryFromContext(raw []byte) (*EngineeringRecoveryExecution, error) {
	var envelope struct {
		Recovery *EngineeringRecoveryExecution `json:"engineering_recovery"`
	}
	if len(raw) == 0 {
		return nil, nil
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	if envelope.Recovery != nil {
		if err := envelope.Recovery.Validate(); err != nil {
			return nil, err
		}
	}
	return envelope.Recovery, nil
}
