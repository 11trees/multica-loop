package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func localControllerFixture(t *testing.T) controllerFixture {
	t.Helper()
	f := newControllerFixture(t)
	task, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(f.task))
	if err != nil {
		t.Fatal(err)
	}
	dbfx.Exec(t, "UPDATE agent SET name=$1 WHERE id=$2", "Project execution "+uuid.NewString(), uuidToString(task.AgentID))
	dbfx.Exec(t, "UPDATE agent_runtime SET runtime_mode='local',daemon_id=$1 WHERE id=$2", "fixture-daemon-"+uuid.NewString(), uuidToString(task.RuntimeID))
	return f
}
func shareControllerProject(t *testing.T, owner, peer controllerFixture) controllerFixture {
	t.Helper()
	dbfx.Exec(t, "UPDATE issue SET project_id=$1 WHERE id=$2", owner.project, peer.issue)
	peer.project = owner.project
	return peer
}
func TestEngineeringProjectExecutionWaitsForPhysicalCleanupAcrossIssuesAndChats(t *testing.T) {
	f := localControllerFixture(t)
	peer := shareControllerProject(t, f, localControllerFixture(t))
	f.begin(t)
	if out := peer.call(t, "begin", map[string]any{"provider": "codex", "pid": 52, "marker": "other-daemon"}, http.StatusOK); out["admitted"] != false || out["waiting_repository"] != true {
		t.Fatal("parallel project run was admitted", out)
	}
	if dbfx.Count(t, "SELECT count(*) FROM engineering_run_guard WHERE task_id=$1 AND phase='waiting' AND NOT project_serialized", peer.task) != 1 {
		t.Fatal("waiting did not retain its actual controller without execution admission")
	}
	f.workspace(t)
	allocation := uuid.NewString()
	f.call(t, "process-reserve", map[string]any{"allocation_id": allocation}, 200)
	f.call(t, "process-bind", map[string]any{"allocation_id": allocation, "pid": 71, "group_id": 71, "marker": "owned-child"}, 200)
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='cancelled' WHERE id=$1", f.task)
	f.call(t, "end", map[string]any{"no_provider_started": false}, 200)
	if out := peer.call(t, "begin", map[string]any{"provider": "codex", "pid": 52, "marker": "other-daemon"}, 200); out["waiting_repository"] != true {
		t.Fatal("logical cancellation or unconfirmed exit released the project")
	}
	f.call(t, "process-exit", map[string]any{"allocation_id": allocation, "pid": 71, "exit_confirmed": true}, 200)
	if out := peer.call(t, "begin", map[string]any{"provider": "codex", "pid": 52, "marker": "other-daemon"}, 200); out["waiting_repository"] != true {
		t.Fatal("provider exit released the project before workspace cleanup")
	}
	f.call(t, "end", map[string]any{"no_provider_started": false}, 200)
	peer.call(t, "begin", map[string]any{"provider": "codex", "pid": 52, "marker": "other-daemon"}, 200)
	native, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(peer.task))
	if err != nil {
		t.Fatal(err)
	}
	chat := dbfx.ChatSession(t, uuidToString(native.AgentID), testutil.Cols{"project_id": f.project})
	chatTask := dbfx.Task(t, uuidToString(native.AgentID), testutil.Cols{"chat_session_id": chat, "runtime_id": uuidToString(native.RuntimeID), "status": "running", "dispatched_at": testutil.Raw("now()"), "started_at": testutil.Raw("now()")})
	row, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(chatTask))
	if err != nil {
		t.Fatal(err)
	}
	turn := peer
	turn.task = chatTask
	turn.controller = uuid.NewString()
	turn.claim = row.DispatchedAt.Time.Format("2006-01-02T15:04:05.999999999Z07:00")
	dbfx.Cleanup(t, "DELETE FROM engineering_run_guard WHERE task_id=$1", chatTask)
	if out := turn.call(t, "begin", map[string]any{"provider": "codex", "pid": 62, "marker": "chat-daemon"}, 200); out["waiting_repository"] != true {
		t.Fatal("chat bypassed project execution ownership")
	}
	peer.call(t, "end", map[string]any{"no_provider_started": true}, 200)
	if out := turn.call(t, "begin", map[string]any{"provider": "codex", "pid": 62, "marker": "chat-daemon"}, 200); out["waiting_repository"] != true {
		t.Fatal("workspace cleanup bypassed native claim settlement")
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed' WHERE id=$1", peer.task)
	if out := turn.call(t, "begin", map[string]any{"provider": "codex", "pid": 62, "marker": "chat-daemon"}, 200); out["admitted"] != true {
		t.Fatal("chat did not resume after final cleanup")
	}
}

func TestEngineeringProjectExecutionSerializesConcurrentAdmissionAndPreservesOtherProjects(t *testing.T) {
	owner := localControllerFixture(t)
	peer := shareControllerProject(t, owner, localControllerFixture(t))
	other := localControllerFixture(t)
	var wait sync.WaitGroup
	results := make(chan map[string]bool, 2)
	for _, f := range []controllerFixture{owner, peer} {
		wait.Add(1)
		go func(f controllerFixture) {
			defer wait.Done()
			raw, _ := json.Marshal(map[string]any{"operation": "begin", "controller_id": f.controller, "dispatched_at": f.claim, "host_id": "fixture-boot", "provider": "codex", "pid": 42, "marker": "fixture-controller"})
			req := withURLParam(httptest.NewRequest(http.MethodPost, "/engineering-controller", strings.NewReader(string(raw))), "taskId", f.task)
			req.Header.Set("Authorization", "Bearer "+f.credential)
			response := httptest.NewRecorder()
			middleware.DaemonAuth(f.h.Queries, nil, nil, nil)(http.HandlerFunc(f.h.RecordEngineeringController)).ServeHTTP(response, req)
			var result map[string]bool
			if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil {
				results <- nil
				return
			}
			results <- result
		}(f)
	}
	wait.Wait()
	close(results)
	admitted, waiting := 0, 0
	for result := range results {
		if result == nil {
			t.Fatal("concurrent admission failed")
		}
		if result["admitted"] {
			admitted++
		}
		if result["waiting_repository"] {
			waiting++
		}
	}
	if admitted != 1 || waiting != 1 || dbfx.Count(t, "SELECT count(*) FROM engineering_run_guard WHERE project_id=$1 AND project_serialized AND phase<>'quiesced'", owner.project) != 1 {
		t.Fatal("project admission was not serialized", admitted, waiting)
	}
	other.begin(t)
}

func TestEngineeringProjectExecutionLeavesOrdinaryCoordinatorsIndependent(t *testing.T) {
	owner := localControllerFixture(t)
	coordinator := shareControllerProject(t, owner, localControllerFixture(t))
	dbfx.Exec(t, "UPDATE agent_task_queue SET is_leader_task=true WHERE id=$1", coordinator.task)
	owner.begin(t)
	coordinator.begin(t)
	guard, err := coordinator.h.Queries.GetEngineeringRunGuard(context.Background(), db.GetEngineeringRunGuardParams{ControllerID: parseUUID(coordinator.controller), WorkspaceID: parseUUID(testWorkspaceID)})
	if err != nil || guard.ProjectSerialized {
		t.Fatal("ordinary coordination acquired the repository execution slot", err)
	}
}

func TestEngineeringProjectExecutionCancelledWaiterCannotAcquireOrReleaseAnotherRun(t *testing.T) {
	owner := localControllerFixture(t)
	peer := shareControllerProject(t, owner, localControllerFixture(t))
	other := shareControllerProject(t, owner, localControllerFixture(t))
	owner.begin(t)
	request := map[string]any{"provider": "codex", "pid": 52, "marker": "waiting-daemon"}
	if out := peer.call(t, "begin", request, 200); out["waiting_repository"] != true {
		t.Fatal("missing wait record")
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='cancelled' WHERE id=$1", peer.task)
	peer.call(t, "begin", request, 409)
	if out := peer.call(t, "end", map[string]any{"no_provider_started": true}, 200); out["quiesced"] != true {
		t.Fatal("waiting controller could not record no-spawn cleanup")
	}
	if out := other.call(t, "begin", request, 200); out["waiting_repository"] != true {
		t.Fatal("cancelled waiter released another controller's project slot")
	}
	owner.call(t, "end", map[string]any{"no_provider_started": true}, 200)
	if out := other.call(t, "begin", request, 200); out["waiting_repository"] != true {
		t.Fatal("physical cleanup bypassed the original native claim")
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed' WHERE id=$1", owner.task)
	// A later retry is a different native claim and cannot make the old one
	// unsettled again after its exact cleanup has already been acknowledged.
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='queued',dispatched_at=NULL WHERE id=$1", owner.task)
	if out := other.call(t, "begin", request, 200); out["admitted"] != true {
		t.Fatal("settled claim was reopened by later native queue state")
	}
}
