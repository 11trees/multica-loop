package handler

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"net/http"
	"os"
	"path/filepath"
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

func TestEngineeringTeamFeedbackProfileUsesNativeMembersAndPreservesIndependentRoles(t *testing.T) {
	ctx := context.Background()
	runtimeID := dbfx.Runtime(t, "Team Feedback profile runtime")
	roles := map[string]string{}
	for _, role := range engineeringTeamRoles["develop"] {
		roles[role] = dbfx.Agent(t, "Team "+role, runtimeID)
	}
	feedback := engineeringTeamFeedback{Triager: roles["context"], Planner: roles["planner"], Reproducer: dbfx.Agent(t, "Team feedback reproducer", runtimeID), Verifier: dbfx.Agent(t, "Team feedback verifier", runtimeID)}
	squad := createSquadAs(t, "", "Team Feedback profile", roles["context"])
	members := []string{}
	for _, id := range roles {
		members = append(members, id)
	}
	members = append(members, feedback.Reproducer, feedback.Verifier)
	for _, id := range members {
		if id != roles["context"] {
			dbfx.Insert(t, "squad_member", testutil.Cols{"squad_id": squad.ID, "member_type": "agent", "member_id": id, "role": "member"})
		}
	}
	workerPath, err := filepath.Abs("../../../packages/command-chain/dist/worker.mjs")
	if err != nil {
		t.Fatal(err)
	}
	h := *testHandler
	h.EngineeringWorker = &engineering.Client{Worker: workerPath, Database: filepath.Join(t.TempDir(), "business.sqlite")}
	definition := map[string]any{"workflow": "develop", "roles": roles, "decision_mode": "balanced", "max_reworks": 1, "feedback": feedback}
	request := func(body any) *http.Request {
		return squadScopeReq("", http.MethodPut, "/engineering", body, map[string]string{"id": squad.ID})
	}
	body := map[string]any{"expected_revision": 0, "definition": definition}
	testutil.Call(t, h.EngineeringTeamProfile, request(body)).Want(http.StatusOK)
	var current struct {
		Profile engineeringTeamSnapshot `json:"profile"`
	}
	raw, err := h.EngineeringWorker.Call(ctx, map[string]any{"actor": map[string]string{"kind": "coordinator"}, "action": "team-lookup", "payload": map[string]string{"workspace_id": testWorkspaceID, "team_id": squad.ID}})
	if err != nil || json.Unmarshal(raw, &current) != nil || current.Profile.Definition.Feedback == nil || *current.Profile.Definition.Feedback != feedback {
		t.Fatal("Team Feedback profile did not retain explicit native roles", err)
	}
	body["expected_revision"] = 1
	invalid := feedback
	invalid.Verifier = roles["reviewer"]
	definition["feedback"] = invalid
	testutil.Call(t, h.EngineeringTeamProfile, request(body)).Want(http.StatusBadRequest)
	invalid = feedback
	invalid.Verifier = dbfx.Agent(t, "Outside Team verifier", runtimeID)
	definition["feedback"] = invalid
	testutil.Call(t, h.EngineeringTeamProfile, request(body)).Want(http.StatusBadRequest)
}

func TestEngineeringTeamStartsNativeTaskWithFrozenDefinitionAndNoLeaderEvaluation(t *testing.T) {
	ctx := context.Background()
	worker, err := filepath.Abs("../../../packages/command-chain/dist/worker.mjs")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(worker); err != nil {
		t.Fatal("build the engineering worker first", err)
	}
	root := t.TempDir()
	repository, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	runtime := dbfx.Runtime(t, "Team start runtime", testutil.Cols{"runtime_mode": "local", "daemon_id": "team-start-fixture"})
	leader := dbfx.Agent(t, "Team executor", runtime)
	squad := createSquadAs(t, "", "Direct delivery Team", leader)
	project := dbfx.Project(t, "Team native project")
	resource, _ := json.Marshal(map[string]string{"local_path": repository, "daemon_id": "team-start-fixture", "execution_mode": "in_place"})
	dbfx.Insert(t, "project_resource", testutil.Cols{"project_id": project, "workspace_id": testWorkspaceID, "resource_type": "local_directory", "resource_ref": json.RawMessage(resource)})
	h := *testHandler
	h.EngineeringWorker = &engineering.Client{Worker: worker, Database: filepath.Join(root, "business.sqlite")}
	taskService := service.NewTaskService(h.Queries, h.TxStarter, testHandler.TaskService.Hub, testHandler.TaskService.Bus)
	h.TaskService = taskService
	taskService.EngineeringTeamOwnsIssue = func(ctx context.Context, issue db.Issue) (bool, error) {
		routing, err := h.engineeringTeamRouting(ctx, issue)
		return routing.Owned, err
	}
	definition := map[string]any{"workflow": "direct", "roles": map[string]string{"executor": leader}, "decision_mode": "balanced", "max_reworks": 2}
	testutil.Call(t, h.EngineeringTeamProfile, squadScopeReq("", http.MethodPut, "/engineering", map[string]any{"expected_revision": 0, "definition": definition}, map[string]string{"id": squad.ID})).Want(http.StatusOK)
	issueID := dbfx.Issue(t, "Authoritative Team goal", testutil.Cols{"project_id": project, "assignee_type": "squad", "assignee_id": squad.ID, "status": "todo"})
	issue, err := h.Queries.GetIssue(ctx, parseUUID(issueID))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dbfx.Exec(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issueID) })
	request := func(body any) *http.Request {
		return withURLParam(newRequest(http.MethodPost, "/team-start", body), "id", issueID)
	}
	testutil.Call(t, h.StartEngineeringTeam, request(map[string]any{"agent_id": leader})).Want(http.StatusBadRequest)
	for _, handler := range []http.HandlerFunc{h.ConfigureEngineeringDirect, h.ConfigureEngineeringBusiness, h.ConfigureEngineeringVerification, h.AuthorizeEngineeringDelivery, h.ConfigureEngineeringReview} {
		testutil.Call(t, handler, withURLParam(newRequest(http.MethodPost, "/engineering", map[string]any{}), "id", issueID)).Want(http.StatusConflict)
	}
	testutil.Call(t, h.StartEngineeringTeam, request(map[string]any{})).Want(http.StatusOK)
	var count, leaders int
	if err = testPool.QueryRow(ctx, "SELECT count(*),count(*) FILTER(WHERE is_leader_task) FROM agent_task_queue WHERE issue_id=$1", issueID).Scan(&count, &leaders); err != nil || count != 1 || leaders != 0 {
		t.Fatalf("Team start queued competing work: count=%d leaders=%d err=%v", count, leaders, err)
	}
	if _, err = taskService.EnqueueTaskForSquadLeader(ctx, issue, parseUUID(leader), parseUUID(squad.ID), pgtype.UUID{}, service.OriginDerived); err == nil {
		t.Fatal("generic leader bypassed frozen Team")
	}
	testutil.Call(t, h.StartEngineeringTeam, request(map[string]any{})).Want(http.StatusOK)
	if err = testPool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issueID).Scan(&count); err != nil || count != 1 {
		t.Fatal("start retry duplicated task", err)
	}
	raw, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "team-binding", "actor": map[string]string{"kind": "host", "workspaceId": testWorkspaceID, "issueId": issueID}})
	if err != nil {
		t.Fatal(err)
	}
	var frozen struct {
		Binding engineeringTeamBinding `json:"binding"`
	}
	if err = json.Unmarshal(raw, &frozen); err != nil || frozen.Binding.Input != "Authoritative Team goal" || frozen.Binding.Profile.TeamID != squad.ID || frozen.Binding.Profile.Revision != 1 {
		t.Fatal("native task did not freeze selected Team", err)
	}
	for _, update := range []map[string]any{{"title": "Changed goal"}, {"description": "Different scope"}, {"project_id": dbfx.Project(t, "Other Team project")}, {"assignee_type": "agent", "assignee_id": leader}} {
		testutil.Call(t, h.UpdateIssue, withURLParam(newRequest(http.MethodPut, "/api/issues/"+issueID, update), "id", issueID)).Want(http.StatusConflict)
	}
	var overview map[string]any
	testutil.Call(t, h.GetEngineeringOverview, withURLParam(newRequest(http.MethodGet, "/engineering", nil), "id", issueID)).Want(http.StatusOK).JSON(&overview)
	team := overview["team"].(map[string]any)
	if team["frozen"] != true || team["aligned"] != true || team["revision"] != float64(1) {
		t.Fatalf("wrong frozen Team view: %+v", team)
	}
	testutil.Call(t, h.DeleteSquad, squadScopeReq("", http.MethodDelete, "/api/squads/"+squad.ID, nil, map[string]string{"id": squad.ID})).Want(http.StatusNoContent)
	afterArchive, err := h.Queries.GetIssue(ctx, parseUUID(issueID))
	if err != nil || uuidToString(afterArchive.AssigneeID) != squad.ID || afterArchive.AssigneeType.String != "squad" {
		t.Fatal("archiving Team changed frozen task ownership", err)
	}
	if _, err = h.Queries.UpdateIssue(ctx, db.UpdateIssueParams{ID: parseUUID(issueID), Title: pgtype.Text{String: "Changed goal", Valid: true}}); err != nil {
		t.Fatal(err)
	}
	testutil.Call(t, h.StartEngineeringTeam, request(map[string]any{})).Want(http.StatusConflict)
}
