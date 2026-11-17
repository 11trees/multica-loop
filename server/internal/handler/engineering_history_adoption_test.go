package handler

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type historyAdoptionFixture struct {
	*historyPreparationFixture
	id, scope string
	blocked   bool
}

func newHistoryAdoptionFixture(t *testing.T) *historyAdoptionFixture {
	f := &historyAdoptionFixture{historyPreparationFixture: newHistoryPreparationFixture(t, testPool), id: uuid.NewString(), scope: strings.Repeat("d", 64)}
	original := f.h.EngineeringHistoryWorker
	f.h.EngineeringHistoryWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		raw, err := original.Call(context.Background(), input)
		if err != nil {
			return nil, err
		}
		var value map[string]any
		_ = json.Unmarshal(raw, &value)
		packet := value["packet"].(map[string]any)
		sections := packet["sections"].([]any)
		row := sections[0].(map[string]any)["rows"].([]any)[0].(map[string]any)
		row["title"] = "Original goal " + input["task_id"].(string)
		row["description"] = "Original obligations\n![private](https://unmaterialized.invalid/file.png)\n```\nKeep the original text"
		row["agile_status"] = "ready_to_close"
		row["run_state"] = "waiting_for_answers"
		row["closure_status"] = "awaiting_read"
		return json.Marshal(value)
	}}
	f.h.EngineeringSourceInspector = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["action"] != "inspect" || input["expected_hash"] != f.h.cfg.EngineeringHistoryHash {
			t.Error("unscoped source inspection")
		}
		return json.Marshal(map[string]any{"format": "loopwork-native-source-inspection-v1", "cutover_id": f.id, "archive_hash": f.h.cfg.EngineeringHistoryHash, "scope_hash": f.scope, "source_namespace": f.namespace, "source_frozen": true, "registered_writers_quiesced": !f.blocked, "physical_quiescence_confirmed": false, "execution_authorized": false})
	}}
	worker := f.h.EngineeringWorker
	f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["action"] == "overview" {
			return json.RawMessage(`{"configured":false}`), nil
		}
		if input["action"] == "team-binding" {
			actor, ok := input["actor"].(map[string]string)
			if !ok || actor["kind"] != "human" || actor["workspaceId"] != localWorkspaceID || actor["userId"] != localUserID || actor["issueId"] == "" {
				t.Error("unscoped readonly Team binding inspection")
			}
			return json.RawMessage(`{"binding":null}`), nil
		}
		return worker.Call(context.Background(), input)
	}}
	proposals := []map[string]any{}
	for _, task := range []string{"source-one", "source-two"} {
		var prepared map[string]any
		testutil.Call(t, f.h.PrepareEngineeringHistoryTask, f.request(http.MethodPost, task, f.input())).Want(200).JSON(&prepared)
		proposals = append(proposals, map[string]any{"id": prepared["id"], "revision": prepared["revision"], "source_task_id": task, "packet_hash": prepared["packet_hash"], "project_id": prepared["project_id"], "team_id": prepared["team_id"], "team_revision": prepared["team_revision"]})
	}
	payload, _ := json.Marshal(map[string]any{"format": "loopwork-cutover-hold-v1", "preparations": proposals})
	f.fx.Exec(t, `INSERT INTO engineering_history_cutover(id,workspace_id,source_namespace,archive_hash,scope_hash,project_ids,prepared_by,payload) VALUES($1,$2,$3,$4,$5,ARRAY[$6::uuid],$7,$8)`, f.id, localWorkspaceID, f.namespace, f.h.cfg.EngineeringHistoryHash, f.scope, proposals[0]["project_id"], localUserID, payload)
	f.fx.Exec(t, "UPDATE engineering_history_cutover SET phase='source_frozen' WHERE id=$1", f.id)
	t.Cleanup(func() {
		f.fx.Exec(t, "DELETE FROM engineering_history_adoption WHERE cutover_id=$1", f.id)
		f.fx.Exec(t, "DELETE FROM engineering_history_cutover WHERE id=$1", f.id)
	})
	return f
}
func (f *historyAdoptionFixture) stageRequest(body any) *http.Request {
	r := withURLParam(newRequest(http.MethodPost, "/history/cutovers/"+f.id+"/stage", body), "cutoverID", f.id)
	r.Header.Set("X-User-ID", localUserID)
	r.Header.Set("X-Workspace-ID", localWorkspaceID)
	return r
}
func (f *historyAdoptionFixture) body() map[string]any {
	return map[string]any{"expected_scope_hash": f.scope}
}

func TestEngineeringHistoryAdoptionStagesAtomicTeamDraftsAndReplaysIdentity(t *testing.T) {
	f := newHistoryAdoptionFixture(t)
	var first, replay map[string]any
	testutil.Call(t, f.h.StageEngineeringHistoryCutover, f.stageRequest(f.body())).Want(200).JSON(&first)
	f.blocked = true
	testutil.Call(t, f.h.StageEngineeringHistoryCutover, f.stageRequest(f.body())).Want(200).JSON(&replay)
	f.blocked = false
	if !historyJSONEqual(historyAdoptionJSON(t, first), historyAdoptionJSON(t, replay)) {
		t.Fatal("acknowledgement retry changed task identity")
	}
	if first["execution_authorized"] != false || len(first["tasks"].([]any)) != 2 {
		t.Fatal("invalid staged cohort", first)
	}
	for _, item := range first["tasks"].([]any) {
		task := item.(map[string]any)
		id := task["issue_id"].(string)
		issue, err := f.h.Queries.GetIssue(context.Background(), parseUUID(id))
		if err != nil {
			t.Fatal(err)
		}
		f.fx.Cleanup(t, "DELETE FROM issue WHERE id=$1", id)
		if issue.Status != "backlog" || issue.AssigneeType.String != "squad" || uuidToString(issue.AssigneeID) != f.team || !strings.Contains(issue.Description.String, "Original obligations") || !strings.Contains(issue.Description.String, "````text") {
			t.Fatal("source goal or inert Team assignment changed", issue)
		}
		if f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", id) != 0 {
			t.Fatal("staging queued a native run")
		}
		var state map[string]any
		testutil.Call(t, f.h.GetEngineeringHistoryPreparation, f.request(http.MethodGet, task["source_task_id"].(string), nil)).Want(200).JSON(&state)
		if len(state["adoptions"].([]any)) != 1 {
			t.Fatal("history did not expose native correspondence")
		}
		if _, err = testPool.Exec(context.Background(), "UPDATE issue SET status='done' WHERE id=$1", id); err == nil {
			t.Fatal("staged work was marked delivered")
		}
		if _, err = testPool.Exec(context.Background(), "INSERT INTO agent_task_queue(agent_id,issue_id,status) VALUES($1,$2,'queued')", f.roles["context"], id); err == nil {
			t.Fatal("staged work entered the native queue")
		}
	}
}
func historyAdoptionJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestEngineeringHistoryAdoptionRejectsStaleAuthorityAndLeavesNoPartialCohort(t *testing.T) {
	f := newHistoryAdoptionFixture(t)
	f.blocked = true
	testutil.Call(t, f.h.StageEngineeringHistoryCutover, f.stageRequest(f.body())).Want(409)
	if f.fx.Count(t, "SELECT count(*) FROM engineering_history_adoption WHERE cutover_id=$1", f.id) != 0 {
		t.Fatal("blocked inspection left tasks")
	}
	f.blocked = false
	f.teamRevision = 2
	testutil.Call(t, f.h.StageEngineeringHistoryCutover, f.stageRequest(f.body())).Want(409)
	if f.fx.Count(t, "SELECT count(*) FROM issue WHERE project_id=(SELECT project_ids[1] FROM engineering_history_cutover WHERE id=$1)", f.id) != 0 {
		t.Fatal("Team rejection left partial issues")
	}
	f.teamRevision = 1
	request := f.stageRequest(f.body())
	request.Header.Set("X-Actor-Type", "agent")
	request.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, f.h.StageEngineeringHistoryCutover, request).Want(403)
	bad := f.body()
	bad["agent_id"] = f.roles["context"]
	testutil.Call(t, f.h.StageEngineeringHistoryCutover, f.stageRequest(bad)).Want(400)
	testutil.Call(t, f.h.StageEngineeringHistoryCutover, f.stageRequest(map[string]any{"expected_scope_hash": strings.Repeat("0", 64)})).Want(409)
}

func TestEngineeringHistoryAdoptionConcurrentRetriesCreateOneCohort(t *testing.T) {
	f := newHistoryAdoptionFixture(t)
	var group sync.WaitGroup
	results := make(chan int, 2)
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			response := httptest.NewRecorder()
			f.h.StageEngineeringHistoryCutover(response, f.stageRequest(f.body()))
			results <- response.Code
		}()
	}
	group.Wait()
	close(results)
	for status := range results {
		if status != 200 {
			t.Fatal("concurrent replay failed", status)
		}
	}
	if f.fx.Count(t, "SELECT count(*) FROM engineering_history_adoption WHERE cutover_id=$1", f.id) != 2 {
		t.Fatal("concurrent calls duplicated tasks")
	}
	rows, err := f.h.Queries.ListEngineeringHistoryAdoptions(context.Background(), db.ListEngineeringHistoryAdoptionsParams{CutoverID: parseUUID(f.id), WorkspaceID: parseUUID(localWorkspaceID)})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		f.fx.Cleanup(t, "DELETE FROM issue WHERE id=$1", uuidToString(row.IssueID))
	}
}

func TestEngineeringHistoryAdoptionWithdrawsOnlyUntouchedDraftsAndKeepsThemInactive(t *testing.T) {
	f := newHistoryAdoptionFixture(t)
	var staged, withdrawn, replay map[string]any
	testutil.Call(t, f.h.StageEngineeringHistoryCutover, f.stageRequest(f.body())).Want(200).JSON(&staged)
	for _, item := range staged["tasks"].([]any) {
		f.fx.Cleanup(t, "DELETE FROM issue WHERE id=$1", item.(map[string]any)["issue_id"])
	}
	testutil.Call(t, f.h.WithdrawEngineeringHistoryCutover, f.stageRequest(f.body())).Want(200).JSON(&withdrawn)
	testutil.Call(t, f.h.WithdrawEngineeringHistoryCutover, f.stageRequest(f.body())).Want(200).JSON(&replay)
	if !historyJSONEqual(historyAdoptionJSON(t, withdrawn), historyAdoptionJSON(t, replay)) {
		t.Fatal("withdrawal replay changed native identity")
	}
	f.fx.Exec(t, "UPDATE engineering_history_cutover SET phase='rollback_pending' WHERE id=$1", f.id)
	f.fx.Exec(t, "UPDATE engineering_history_cutover SET phase='cancelled' WHERE id=$1", f.id)
	for _, item := range withdrawn["tasks"].([]any) {
		row := item.(map[string]any)
		id := row["issue_id"].(string)
		issue, err := f.h.Queries.GetIssue(context.Background(), parseUUID(id))
		if err != nil {
			t.Fatal(err)
		}
		if row["phase"] != "withdrawn" || issue.Status != "cancelled" || !strings.Contains(issue.Description.String, "Original obligations") {
			t.Fatal("withdrawal lost original native task", row)
		}
		if _, err = testPool.Exec(context.Background(), "UPDATE issue SET status='todo' WHERE id=$1", id); err == nil {
			t.Fatal("withdrawn task reopened after source rollback")
		}
	}
}

func TestEngineeringHistoryAdoptionDoesNotCancelHumanEditsOrPartOfACohort(t *testing.T) {
	f := newHistoryAdoptionFixture(t)
	var staged map[string]any
	testutil.Call(t, f.h.StageEngineeringHistoryCutover, f.stageRequest(f.body())).Want(200).JSON(&staged)
	tasks := staged["tasks"].([]any)
	for _, item := range tasks {
		f.fx.Cleanup(t, "DELETE FROM issue WHERE id=$1", item.(map[string]any)["issue_id"])
	}
	edited := tasks[1].(map[string]any)["issue_id"].(string)
	f.fx.Exec(t, "UPDATE issue SET title='Human edited this task' WHERE id=$1", edited)
	testutil.Call(t, f.h.WithdrawEngineeringHistoryCutover, f.stageRequest(f.body())).Want(409)
	if f.fx.Count(t, "SELECT count(*) FROM engineering_history_adoption WHERE cutover_id=$1 AND phase='staged'", f.id) != 2 {
		t.Fatal("withdrawal cancelled part of the cohort")
	}
	for _, item := range tasks {
		issue, err := f.h.Queries.GetIssue(context.Background(), parseUUID(item.(map[string]any)["issue_id"].(string)))
		if err != nil || issue.Status != "backlog" {
			t.Fatal("failed withdrawal changed native status", err)
		}
	}
	issue, _ := f.h.Queries.GetIssue(context.Background(), parseUUID(edited))
	if issue.Title != "Human edited this task" {
		t.Fatal("withdrawal overwrote human input")
	}
}
