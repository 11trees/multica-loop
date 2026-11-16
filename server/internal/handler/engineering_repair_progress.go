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
	"github.com/multica-ai/multica/server/internal/engineering/ownership"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type engineeringBusinessProgress struct {
	Applied               bool    `json:"applied"`
	Hash                  string  `json:"hash"`
	CaseID                string  `json:"case_id"`
	VerificationAttemptID string  `json:"verification_attempt_id"`
	TargetHash            string  `json:"target_hash"`
	ApplicationHash       string  `json:"application_hash"`
	ReadyHash             string  `json:"ready_hash"`
	WorkspaceID           string  `json:"workspace_id"`
	IssueID               string  `json:"issue_id"`
	TaskID                string  `json:"task_id"`
	EntryTaskID           string  `json:"entry_task_id,omitempty"`
	ExecutionHintHash     string  `json:"execution_hint_hash,omitempty"`
	AgentID               string  `json:"agent_id"`
	AttemptID             string  `json:"attempt_id"`
	Chain                 string  `json:"chain"`
	DraftID               *string `json:"draft_id"`
	DraftHash             *string `json:"draft_hash"`
	ResultID              string  `json:"result_id"`
	ResultHash            string  `json:"result_hash"`
	CompletionEventHash   string  `json:"completion_event_hash"`
	Revision              int     `json:"revision"`
	Sequence              int     `json:"sequence"`
}
type engineeringNativeProgress struct {
	Hash            string `json:"hash"`
	PublicationHash string `json:"publication_hash"`
	ProgressHash    string `json:"progress_hash"`
	TaskID          string `json:"task_id"`
	AttemptID       string `json:"attempt_id"`
	WorkspaceID     string `json:"workspace_id"`
	IssueID         string `json:"issue_id"`
	AgentID         string `json:"agent_id"`
	UserID          string `json:"user_id"`
	RuntimeID       string `json:"runtime_id"`
	ProjectID       string `json:"project_id"`
	Status          string `json:"status"`
	ControllersHash string `json:"controllers_hash"`
}
type engineeringRecoveryProgress struct {
	Business engineeringBusinessProgress `json:"business"`
	Native   engineeringNativeProgress   `json:"native"`
}

func engineeringOptionalText(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
func engineeringBusinessProgressHash(p engineeringBusinessProgress) string {
	prefix := []string{"multica:repair-business-progress:1"}
	if p.EntryTaskID != "" {
		prefix = []string{"multica:repair-business-progress:2", p.EntryTaskID, p.ExecutionHintHash}
	}
	return engineeringHandoffFieldsHash(append(prefix, []string{p.CaseID, p.VerificationAttemptID, p.TargetHash, p.ApplicationHash, p.ReadyHash, p.WorkspaceID, p.IssueID, p.TaskID, p.AgentID, p.AttemptID, p.Chain, engineeringOptionalText(p.DraftID), engineeringOptionalText(p.DraftHash), p.ResultID, p.ResultHash, p.CompletionEventHash, strconv.Itoa(p.Revision), strconv.Itoa(p.Sequence)}...)...)
}
func engineeringNativeProgressHash(p engineeringNativeProgress) string {
	return engineeringHandoffFieldsHash("multica:repair-native-progress:1", p.PublicationHash, p.ProgressHash, p.TaskID, p.AttemptID, p.WorkspaceID, p.IssueID, p.AgentID, p.UserID, p.RuntimeID, p.ProjectID, p.Status, p.ControllersHash)
}

func (h *Handler) ReconcileEngineeringRecoveryProgress(ctx context.Context, authority engineeringAdminAuthority) error {
	if h.EngineeringTakeoverControl == nil {
		return nil
	}
	raw, err := h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-observing", "authority": authority})
	if err != nil {
		return err
	}
	var pending []struct {
		CaseID string `json:"case_id"`
	}
	if err = json.Unmarshal(raw, &pending); err != nil {
		return err
	}
	var failures []error
	for _, item := range pending {
		if _, err = h.EngineeringTakeoverControl.Call(ctx, map[string]any{"action": "observe-handoff", "authority": authority, "case_id": item.CaseID}); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

// A terminal process is insufficient: both reads must find the same new,
// owner-applied ordinary result, exact claim and confirmed physical cleanup.
func (h *Handler) observeEngineeringRepairHandoff(ctx context.Context, raw json.RawMessage) (any, error) {
	var input engineeringPublicationRequest
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, err
	}
	initial, err := h.readEngineeringPublicationContext(ctx, input)
	if err != nil {
		return nil, err
	}
	value, err := h.readEngineeringRecoveryProgress(ctx, input, initial)
	if err != nil {
		return nil, err
	}
	if value == nil {
		return map[string]bool{"closed": false}, nil
	}
	if _, err = h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-progress", "authority": input.Authority, "case_id": input.CaseID, "payload": value}); err != nil {
		return nil, err
	}
	fresh, err := h.readEngineeringRecoveryProgress(ctx, input, initial)
	if err != nil {
		return nil, err
	}
	if fresh == nil || !engineeringSameJSON(fresh, value) {
		return nil, fmt.Errorf("recovery progress changed before Case closure")
	}
	return h.EngineeringAdminWorker.Call(ctx, map[string]any{"action": "handoff-close", "authority": input.Authority, "case_id": input.CaseID, "payload": fresh})
}
func (h *Handler) readEngineeringRecoveryProgress(ctx context.Context, input engineeringPublicationRequest, initial engineeringHandoffContext) (*engineeringRecoveryProgress, error) {
	current, err := h.readEngineeringPublicationContext(ctx, input)
	if err != nil {
		return nil, err
	}
	if current.CurrentIntentRevision != initial.CurrentIntentRevision || current.TargetHash != initial.TargetHash || !engineeringSameJSON(current.Application, initial.Application) || !engineeringSameJSON(current.Reservation, initial.Reservation) {
		return nil, fmt.Errorf("recovery observation authority or proof changed")
	}
	if current.Reservation == nil || current.Publication == nil {
		return nil, fmt.Errorf("recovery observation has no acknowledged native publication")
	}
	row, err := h.Queries.GetEngineeringRepairPublication(ctx, current.TargetHash)
	if err != nil {
		return nil, err
	}
	var published engineeringHandoffPublished
	var application engineeringHandoffApplication
	if json.Unmarshal([]byte(row.Payload), &published) != nil || json.Unmarshal(current.Application, &application) != nil || !engineeringSameJSON(current.Publication, &published) {
		return nil, fmt.Errorf("native and management publication receipts differ")
	}
	p := published.Publication
	r := current.Reservation
	if !p.Published || engineeringHandoffPublicationHash(p) != p.Hash || validateEngineeringHandoffReady(published.Ready, current, application) != nil || p.CaseID != input.CaseID || p.TargetHash != current.TargetHash || p.VerificationAttemptID != r.VerificationAttemptID || p.TaskID != r.Continuation.TaskID || p.WorkspaceID != r.Continuation.WorkspaceID || p.IssueID != r.Continuation.IssueID || p.AgentID != r.Continuation.AgentID || p.UserID != r.Continuation.UserID || p.RuntimeID != current.Request.Inspection.RuntimeID || p.ReadyHash != published.Ready.Hash || p.ApplicationHash != application.Hash || p.ReservationHash != r.Hash || uuidToString(row.TaskID) != p.TaskID || uuidToString(row.ProjectID) != r.ProjectID || uuidToString(row.WorkspaceID) != p.WorkspaceID {
		return nil, fmt.Errorf("invalid recovery publication identity")
	}
	response, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "repair-business-progress", "actor": map[string]string{"kind": "host", "workspaceId": p.WorkspaceID, "issueId": p.IssueID}, "payload": map[string]string{"target_hash": p.TargetHash, "application_hash": p.ApplicationHash, "ready_hash": p.ReadyHash}})
	if err != nil {
		return nil, err
	}
	var result struct {
		Progress *engineeringBusinessProgress `json:"progress"`
	}
	if err = json.Unmarshal(response, &result); err != nil {
		return nil, err
	}
	if result.Progress == nil {
		return nil, nil
	}
	b := result.Progress
	if (b.EntryTaskID == "") != (b.ExecutionHintHash == "") || b.EntryTaskID != "" && b.EntryTaskID == b.TaskID || !b.Applied || engineeringBusinessProgressHash(*b) != b.Hash || b.CaseID != p.CaseID || b.VerificationAttemptID != p.VerificationAttemptID || b.TargetHash != p.TargetHash || b.ApplicationHash != p.ApplicationHash || b.ReadyHash != p.ReadyHash || (b.EntryTaskID == "" && b.TaskID != p.TaskID || b.EntryTaskID != "" && (b.EntryTaskID != p.TaskID || len(b.ExecutionHintHash) != 64)) || b.WorkspaceID != p.WorkspaceID || b.IssueID != p.IssueID || b.AgentID != p.AgentID || b.Revision != r.Continuation.ExpectedRevision || engineeringOptionalText(b.DraftID) != engineeringOptionalText(application.DraftID) || b.ResultID == "" || len(b.ResultHash) != 64 || len(b.CompletionEventHash) != 64 {
		return nil, fmt.Errorf("business result is not this published native execution")
	}
	taskID, err := util.ParseUUID(b.TaskID)
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
		return nil, fmt.Errorf("recovery observation storage unavailable")
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
	if uuidToString(task.IssueID) != p.IssueID || uuidToString(task.AgentID) != p.AgentID || uuidToString(task.RuntimeID) != p.RuntimeID || uuidToString(task.OriginatorUserID) != p.UserID {
		return nil, fmt.Errorf("observed native task identity changed")
	}
	if task.Status != "completed" && task.Status != "failed" || !task.CompletedAt.Valid || !task.DispatchedAt.Valid {
		return nil, nil
	}
	issue, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: workspaceID, ID: task.IssueID})
	if err != nil {
		return nil, err
	}
	if issue.ProjectID != projectID {
		return nil, fmt.Errorf("observed native project changed")
	}
	category, err := issuestatus.CategoryWithError(ctx, q, workspaceID, issue.Status)
	if err != nil {
		return nil, err
	}
	if category == issuestatus.CategoryClosed {
		return nil, nil
	}
	if _, err = q.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{WorkspaceID: workspaceID, ProjectID: projectID}); err == nil {
		return nil, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	reserved, err := q.ListEngineeringRepairHandoffReservations(ctx, db.ListEngineeringRepairHandoffReservationsParams{WorkspaceID: workspaceID, ProjectID: projectID})
	if err != nil {
		return nil, err
	}
	if len(reserved) != 0 {
		return nil, nil
	}
	reservation, err := q.GetEngineeringRepairHandoff(ctx, current.TargetHash)
	if err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(r)
	if reservation.Phase != "published" || reservation.Payload != string(encoded) {
		return nil, fmt.Errorf("observed native publication reservation changed")
	}
	guards, err := q.ListEngineeringProjectControllers(ctx, db.ListEngineeringProjectControllersParams{WorkspaceID: workspaceID, ProjectID: projectID})
	if err != nil {
		return nil, err
	}
	claim := task.DispatchedAt.Time.UnixMicro()
	attemptID := b.TaskID + ":" + strconv.FormatInt(claim, 10)
	if b.AttemptID != attemptID {
		return nil, fmt.Errorf("business result changed its native claim")
	}
	if b.TaskID != p.TaskID {
		hint, e := h.engineeringRecoveryForTask(ctx, task, p.WorkspaceID)
		if e != nil {
			return nil, e
		}
		if hint == nil || hint.Hash != b.ExecutionHintHash || hint.EntryTaskID != p.TaskID || hint.TargetHash != p.TargetHash || engineeringOptionalText(hint.DraftID) != engineeringOptionalText(b.DraftID) || hint.Revision != b.Revision || b.Chain != "direct" && hint.Sequence > b.Sequence {
			return nil, fmt.Errorf("business result has no matching native continuation context")
		}
	}
	facts := struct {
		Controllers []db.EngineeringRunGuard   `json:"controllers"`
		Processes   []db.EngineeringRunProcess `json:"processes"`
	}{Controllers: []db.EngineeringRunGuard{}, Processes: []db.EngineeringRunProcess{}}
	for _, guard := range guards {
		if guard.TaskID != taskID || !guard.ClaimAt.Valid || guard.ClaimAt.Time.UnixMicro() != claim {
			continue
		}
		if guard.RuntimeID != task.RuntimeID || guard.ScopeKind.String != "issue" || guard.ScopeID != task.IssueID {
			return nil, fmt.Errorf("observed controller changed its native scope")
		}
		processes, e := q.ListEngineeringRunProcesses(ctx, db.ListEngineeringRunProcessesParams{WorkspaceID: workspaceID, ControllerID: guard.ControllerID})
		if e != nil {
			return nil, e
		}
		if guard.Phase != "quiesced" || !ownership.ControllerCleanupConfirmed(guard, processes) {
			return nil, nil
		}
		facts.Controllers = append(facts.Controllers, guard)
		facts.Processes = append(facts.Processes, processes...)
	}
	if len(facts.Controllers) == 0 {
		return nil, nil
	}
	if b.Chain == "direct" {
		if b.DraftID != nil || b.DraftHash != nil || b.Sequence != 0 {
			return nil, fmt.Errorf("Direct recovery result has an invalid completion identity")
		}
	} else if b.DraftID == nil || b.DraftHash == nil || b.Sequence <= r.Continuation.ExpectedSequence {
		return nil, fmt.Errorf("YAML recovery has no new completed checkpoint")
	}
	check, err := h.readEngineeringPublicationContext(ctx, input)
	if err != nil {
		return nil, err
	}
	if check.CurrentIntentRevision != initial.CurrentIntentRevision || check.TargetHash != current.TargetHash || !engineeringSameJSON(check.Publication, current.Publication) {
		return nil, fmt.Errorf("recovery intent or current proof changed after business read")
	}
	blob, _ := json.Marshal(facts)
	digest := sha256.Sum256(blob)
	native := engineeringNativeProgress{PublicationHash: p.Hash, ProgressHash: b.Hash, TaskID: b.TaskID, AttemptID: attemptID, WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, AgentID: p.AgentID, UserID: p.UserID, RuntimeID: p.RuntimeID, ProjectID: r.ProjectID, Status: task.Status, ControllersHash: hex.EncodeToString(digest[:])}
	native.Hash = engineeringNativeProgressHash(native)
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &engineeringRecoveryProgress{Business: *b, Native: native}, nil
}
