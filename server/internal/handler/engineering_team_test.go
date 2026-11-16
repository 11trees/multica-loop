package handler

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestEngineeringTeamProfileRequiresNativeRosterAndManagement(t *testing.T) {
	runtime := dbfx.Runtime(t, "Team profile runtime")
	leader := dbfx.Agent(t, "Team leader", runtime)
	foreign := dbfx.Agent(t, "Outside Team", runtime)
	squad := createSquadAs(t, "", "Versioned engineering Team", leader)
	recorder := &engineeringRecorder{response: json.RawMessage(`{"profile":null}`)}
	h := *testHandler
	h.EngineeringWorker = recorder
	request := func(method string, body any) *http.Request {
		return squadScopeReq("", method, "/api/squads/"+squad.ID+"/engineering", body, map[string]string{"id": squad.ID})
	}
	testutil.Call(t, h.EngineeringTeamProfile, request(http.MethodGet, nil)).Want(http.StatusOK)
	actor := recorder.inputs[0]["actor"].(map[string]any)
	if actor["teamId"] != squad.ID || actor["workspaceId"] != testWorkspaceID || actor["userId"] != testUserID {
		t.Fatal("Team scope not projected from native authorization")
	}
	definition := map[string]any{"workflow": "direct", "roles": map[string]string{"executor": leader}, "decision_mode": "balanced", "max_reworks": 2}
	body := map[string]any{"expected_revision": 0, "definition": definition}
	testutil.Call(t, h.EngineeringTeamProfile, request(http.MethodPut, body)).Want(http.StatusOK)
	definition["roles"] = map[string]string{"executor": foreign}
	testutil.Call(t, h.EngineeringTeamProfile, request(http.MethodPut, body)).Want(http.StatusBadRequest)
	definition["roles"] = map[string]string{"executor": leader}
	definition["repository_path"] = "/invented"
	testutil.Call(t, h.EngineeringTeamProfile, request(http.MethodPut, body)).Want(http.StatusBadRequest)
	delete(definition, "repository_path")
	definition["workflow"] = "unknown"
	testutil.Call(t, h.EngineeringTeamProfile, request(http.MethodPut, body)).Want(http.StatusBadRequest)
	stranger := createPlainMember(t, "team-profile-stranger@multica.test")
	denied := squadScopeReq(stranger, http.MethodPut, "/api/squads/"+squad.ID+"/engineering", body, map[string]string{"id": squad.ID})
	testutil.Call(t, h.EngineeringTeamProfile, denied).Want(http.StatusForbidden)
	if len(recorder.inputs) != 2 {
		t.Fatal("invalid Team definition reached worker")
	}
	machine := request(http.MethodPut, body)
	machine.Header.Set("X-Actor-Type", "agent")
	machine.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, h.EngineeringTeamProfile, machine).Want(http.StatusForbidden)
}
