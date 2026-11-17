package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func (f *historyActivationFixture) deactivationBody() map[string]any {
	return map[string]any{"expected_scope_hash": f.scope, "expected_workspace_hash": f.workspaceHash}
}

func activateHistoryForDeactivation(t *testing.T, f *historyActivationFixture) historyActivationReceipt {
	t.Helper()
	var activation historyActivationReceipt
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("in_place"))).Want(200).JSON(&activation)
	return activation
}

func TestEngineeringHistoryDeactivationRetainsReceiptsAndPermanentTaskBarriers(t *testing.T) {
	f := newHistoryActivationFixture(t)
	activation := activateHistoryForDeactivation(t, f)
	machine := f.stageRequest(f.deactivationBody())
	machine.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, f.h.DeactivateEngineeringHistoryCutover, machine).Want(403)
	invalid := f.deactivationBody()
	invalid["repository_path"] = "/caller-selected/path"
	testutil.Call(t, f.h.DeactivateEngineeringHistoryCutover, f.stageRequest(invalid)).Want(400)
	var first, replay historyDeactivationReceipt
	testutil.Call(t, f.h.DeactivateEngineeringHistoryCutover, f.stageRequest(f.deactivationBody())).Want(200).JSON(&first)
	if first.ExecutionStarted || len(first.Tasks) != 2 || len(first.Resources) != 1 || !historyJSONEqual(first.Activation, historyAdoptionJSON(t, activation)) {
		t.Fatal("deactivation lost activation/task/resource history")
	}
	if f.fx.Count(t, "SELECT count(*) FROM engineering_history_cutover WHERE id=$1 AND phase='deactivated' AND activation IS NOT NULL AND deactivation IS NOT NULL", f.id) != 1 || f.fx.Count(t, "SELECT count(*) FROM project_resource WHERE project_id=$1", f.project) != 0 || f.fx.Count(t, "SELECT count(*) FROM engineering_history_adoption WHERE cutover_id=$1 AND phase='withdrawn'", f.id) != 2 {
		t.Fatal("native cohort was only partly deactivated")
	}
	for _, task := range first.Tasks {
		issueID := task["issue_id"]
		if f.fx.Count(t, "SELECT count(*) FROM issue WHERE id=$1 AND status='cancelled' AND description LIKE '%Original obligations%'", issueID) != 1 {
			t.Fatal("withdrawal lost the task's original goal/material")
		}
		if _, err := testPool.Exec(context.Background(), "UPDATE issue SET status='todo' WHERE id=$1", issueID); err == nil {
			t.Fatal("a withdrawn task reopened")
		}
	}
	if _, err := testPool.Exec(context.Background(), "UPDATE engineering_history_cutover SET deactivation='{}' WHERE id=$1", f.id); err == nil {
		t.Fatal("deactivation receipt was mutable")
	}
	f.blocked = true // Committed acknowledgement is independent of mutable source readiness.
	testutil.Call(t, f.h.DeactivateEngineeringHistoryCutover, f.stageRequest(f.deactivationBody())).Want(200).JSON(&replay)
	if !historyJSONEqual(historyAdoptionJSON(t, first), historyAdoptionJSON(t, replay)) {
		t.Fatal("deactivation acknowledgement changed after commit")
	}
	testutil.Call(t, f.h.ActivateEngineeringHistoryCutover, f.stageRequest(f.activationBody("in_place"))).Want(409)
	f.fx.Exec(t, "UPDATE engineering_history_cutover SET phase='rollback_pending' WHERE id=$1", f.id)
	f.fx.Exec(t, "UPDATE engineering_history_cutover SET phase='cancelled' WHERE id=$1", f.id)
	testutil.Call(t, f.h.DeactivateEngineeringHistoryCutover, f.stageRequest(f.deactivationBody())).Want(200).JSON(&replay)
	if !historyJSONEqual(historyAdoptionJSON(t, first), historyAdoptionJSON(t, replay)) {
		t.Fatal("source rollback lost the native acknowledgement")
	}
	wrong := f.deactivationBody()
	wrong["expected_workspace_hash"] = strings.Repeat("f", 64)
	testutil.Call(t, f.h.DeactivateEngineeringHistoryCutover, f.stageRequest(wrong)).Want(409)
}

func TestEngineeringHistoryDeactivationRefusesChangedOrUsedCohortsAtomically(t *testing.T) {
	for _, kind := range []string{"task", "workspace", "writer", "resource", "execution", "binding", "worker"} {
		t.Run(kind, func(t *testing.T) {
			f := newHistoryActivationFixture(t)
			activation := activateHistoryForDeactivation(t, f)
			switch kind {
			case "task":
				f.fx.Exec(t, "UPDATE issue SET title=title || ' changed' WHERE id=$1", activation.Tasks[0]["issue_id"])
			case "workspace":
				f.drift = true
			case "writer":
				f.blocked = true
			case "resource":
				f.fx.Exec(t, "UPDATE project_resource SET label='Retain user changes' WHERE id=$1", activation.Resources[0].ID)
			case "execution":
				f.fx.Task(t, activation.Roles[0].AgentID, testutil.Cols{"runtime_id": f.runtime, "issue_id": activation.Tasks[0]["issue_id"], "status": "completed"})
			case "binding", "worker":
				original := f.h.EngineeringWorker
				f.h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
					if input["action"] == "team-binding" {
						if kind == "worker" {
							return nil, errors.New("interrupted worker")
						}
						return json.RawMessage(`{"binding":{"retained":true}}`), nil
					}
					return original.Call(context.Background(), input)
				}}
			}
			testutil.Call(t, f.h.DeactivateEngineeringHistoryCutover, f.stageRequest(f.deactivationBody())).Want(409)
			if f.fx.Count(t, "SELECT count(*) FROM engineering_history_cutover WHERE id=$1 AND phase='activated' AND deactivation IS NULL", f.id) != 1 || f.fx.Count(t, "SELECT count(*) FROM project_resource WHERE project_id=$1", f.project) != 1 || f.fx.Count(t, "SELECT count(*) FROM engineering_history_adoption WHERE cutover_id=$1 AND phase='activated'", f.id) != 2 || f.fx.Count(t, "SELECT count(*) FROM issue i JOIN engineering_history_adoption a ON i.id=a.issue_id WHERE a.cutover_id=$1 AND i.status='backlog'", f.id) != 2 {
				t.Fatal("refused deactivation partly mutated the cohort")
			}
		})
	}
}

func TestEngineeringHistoryDeactivationLocksOutConcurrentTaskAcceptance(t *testing.T) {
	f := newHistoryActivationFixture(t)
	activation := activateHistoryForDeactivation(t, f)
	original := f.h.EngineeringSourceInspector
	entered, release := make(chan struct{}), make(chan struct{})
	f.h.EngineeringSourceInspector = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["action"] == "workspace-check" {
			close(entered)
			<-release
		}
		return original.Call(context.Background(), input)
	}}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response := httptest.NewRecorder()
		f.h.DeactivateEngineeringHistoryCutover(response, f.stageRequest(f.deactivationBody()))
		done <- response
	}()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("deactivation did not reach locked source inspection")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	_, err := testPool.Exec(ctx, "UPDATE issue SET status='todo' WHERE id=$1", activation.Tasks[0]["issue_id"])
	cancel()
	close(release)
	if err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("concurrent acceptance did not wait for the exact task lock", err)
	}
	select {
	case response := <-done:
		if response.Code != 200 {
			t.Fatal("deactivation failed after locked inspection", response.Code, response.Body.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("deactivation did not finish")
	}
	if _, err := testPool.Exec(context.Background(), "UPDATE issue SET status='todo' WHERE id=$1", activation.Tasks[0]["issue_id"]); err == nil {
		t.Fatal("concurrent task acceptance escaped permanent withdrawal")
	}
}
