package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestEngineeringHistoryCutoverRejectsTeamStartBeforeWorker(t *testing.T) {
	runtime := dbfx.Runtime(t, "Cutover start runtime")
	leader := dbfx.Agent(t, "Cutover start leader", runtime)
	squad := createSquadAs(t, "", "Cutover held Team", leader)
	project := dbfx.Project(t, "Cutover held project")
	issue := dbfx.Issue(t, "Held source adoption", testutil.Cols{"project_id": project, "assignee_type": "squad", "assignee_id": squad.ID, "status": "todo"})
	id := uuid.NewString()
	dbfx.Exec(t, `INSERT INTO engineering_history_cutover(id,workspace_id,source_namespace,archive_hash,scope_hash,project_ids,prepared_by,payload)
        VALUES($1,$2,$3,$4,$5,ARRAY[$6::uuid],$7,'{}')`, id, testWorkspaceID, uuid.NewString(), strings.Repeat("a", 64), strings.Repeat("b", 64), project, testUserID)
	t.Cleanup(func() { dbfx.Exec(t, "DELETE FROM engineering_history_cutover WHERE id=$1", id) })
	h := *testHandler
	recorder := &engineeringRecorder{response: json.RawMessage(`{"started":true}`)}
	h.EngineeringWorker = recorder
	request := withURLParam(newRequest(http.MethodPost, "/engineering/team/start", map[string]any{}), "id", issue)
	var result map[string]any
	testutil.Call(t, h.StartEngineeringTeam, request).Want(http.StatusConflict).JSON(&result)
	if len(recorder.inputs) != 0 || !strings.Contains(result["error"].(string), "cutover") {
		t.Fatal("held Team start touched business state", result)
	}
	if dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue) != 0 {
		t.Fatal("held Team start queued execution")
	}
	for _, phase := range []string{"source_frozen", "rollback_pending"} {
		dbfx.Exec(t, "UPDATE engineering_history_cutover SET phase=$2 WHERE id=$1", id, phase)
		loaded, err := h.Queries.GetIssue(context.Background(), parseUUID(issue))
		if err != nil {
			t.Fatal(err)
		}
		if err = h.startEngineeringTeamIssue(context.Background(), loaded, testUserID); err == nil || !strings.Contains(err.Error(), "cutover") {
			t.Fatal("cutover phase allowed Team start", phase, err)
		}
	}
}
