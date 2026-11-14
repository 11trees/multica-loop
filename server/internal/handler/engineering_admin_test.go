package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
)

type engineeringAdminTestWorker struct {
	call func(map[string]any) (json.RawMessage, error)
}

func (w engineeringAdminTestWorker) Call(_ context.Context, input any) (json.RawMessage, error) {
	return w.call(input.(map[string]any))
}

func TestEngineeringAdminObservationRetryPinsNativeScopeAndAcknowledgesAfterManagement(t *testing.T) {
	_, _, taskID, agentID, issueID := engineeringRunFixture(t)
	task, _ := testHandler.Queries.GetAgentTask(context.Background(), parseUUID(taskID))
	row := map[string]any{"workspaceId": testWorkspaceID, "issueId": issueID, "agentId": agentID, "attemptId": taskID + ":" + strconv.FormatInt(task.DispatchedAt.Time.UnixMicro(), 10), "chain": "verification", "observationId": "role-request:" + taskID, "summary": "Original conflict", "snapshotHash": strings.Repeat("a", 64), "requestHash": strings.Repeat("b", 64), "kernelVersion": "sha256:" + strings.Repeat("c", 64), "hostVersion": "sha256:" + strings.Repeat("d", 64)}
	acknowledged, failAck, stored := false, true, false
	observations := 0
	h := *testHandler
	h.EngineeringWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		switch input["action"] {
		case "repair-observations":
			if acknowledged {
				return json.RawMessage(`[]`), nil
			}
			return json.Marshal([]any{row})
		case "repair-observation-ack":
			if !stored {
				t.Fatal("business acknowledged before management persistence")
			}
			payload := input["payload"].(map[string]string)
			if payload["case_id"] != "REPAIR-fixture" || payload["snapshot_hash"] != row["snapshotHash"] {
				t.Fatal("observation receipt changed")
			}
			if failAck {
				failAck = false
				return nil, fmt.Errorf("interrupted acknowledgement")
			}
			acknowledged = true
			return json.RawMessage(`{"acknowledged":true}`), nil
		default:
			return nil, fmt.Errorf("unexpected business action")
		}
	}}
	h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["action"] != "observe" {
			t.Fatal("unexpected management action")
		}
		observations++
		stored = true
		observation := input["observation"].(map[string]any)
		if observation["sourceVersion"] != "kernel:"+row["kernelVersion"].(string)+";api:"+row["hostVersion"].(string) {
			t.Fatal("actual original runtime versions lost")
		}
		return json.Marshal(map[string]string{"caseId": "REPAIR-fixture", "workspaceId": testWorkspaceID, "scopeKey": testWorkspaceID + ":" + issueID + ":verification"})
	}}
	authority := engineeringAdminAuthority{OwnerID: "host", Token: 1}
	if err := h.ReconcileEngineeringAdmin(context.Background(), authority); err == nil {
		t.Fatal("interrupted cross-store acknowledgement was hidden")
	}
	if err := h.ReconcileEngineeringAdmin(context.Background(), authority); err != nil {
		t.Fatal(err)
	}
	if !acknowledged || observations != 2 {
		t.Fatal("original observation was not replayed")
	}
	acknowledged = false
	row["agentId"] = testUserID
	if err := h.ReconcileEngineeringAdmin(context.Background(), authority); err == nil {
		t.Fatal("foreign native role entered management")
	}
	if observations != 2 {
		t.Fatal("invalid native role reached management")
	}
}

func TestEngineeringAdminReadFailureRetainsNativeInterventionProjection(t *testing.T) {
	issueID := dbfx.Issue(t, "Retained original conflict")
	h := *testHandler
	h.EngineeringWorker = &engineeringRecorder{response: json.RawMessage(`{"enabled":true,"configured":true,"intervention":{"summary":"Original evidence retained"}}`)}
	h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		if input["workspace_id"] != testWorkspaceID || input["issue_id"] != issueID {
			t.Fatal("management lookup escaped the authenticated native issue")
		}
		return nil, fmt.Errorf("management unavailable")
	}}
	request := withURLParam(newRequest(http.MethodGet, "/engineering", nil), "id", issueID)
	var result map[string]json.RawMessage
	testutil.Call(t, h.GetEngineeringOverview, request).Want(http.StatusOK).JSON(&result)
	if !strings.Contains(string(result["intervention"]), "Original evidence retained") || string(result["repair"]) != `{"available":false}` {
		t.Fatal("management outage replaced the business checkpoint")
	}
}

func TestEngineeringAdminRenewalDoesNotWaitForBusinessDiscovery(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started, renewed, done := make(chan struct{}), make(chan struct{}, 1), make(chan struct{})
	h := *testHandler
	h.EngineeringWorker = engineeringAdminTestWorker{call: func(_ map[string]any) (json.RawMessage, error) { close(started); <-ctx.Done(); return nil, ctx.Err() }}
	h.EngineeringAdminWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
		switch input["action"] {
		case "acquire":
			return json.Marshal(map[string]any{"authority": engineeringAdminAuthority{OwnerID: input["owner_id"].(string), Token: 1}})
		case "renew":
			select {
			case renewed <- struct{}{}:
			default:
			}
			return json.RawMessage(`{"renewed":true}`), nil
		case "release":
			return json.RawMessage(`{"released":true}`), nil
		default:
			return nil, fmt.Errorf("unexpected management operation")
		}
	}}
	go func() { h.runEngineeringAdmin(ctx, 20*time.Millisecond); close(done) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("discovery did not start")
	}
	select {
	case <-renewed:
	case <-time.After(time.Second):
		t.Fatal("blocked business discovery starved supervision renewal")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("supervision did not stop")
	}
}
