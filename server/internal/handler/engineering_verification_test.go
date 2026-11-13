package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

type engineeringRecorder struct {
	inputs   []map[string]any
	response json.RawMessage
	err      error
}

func (s *engineeringRecorder) Call(_ context.Context, input any) (json.RawMessage, error) {
	data, _ := json.Marshal(input)
	var decoded map[string]any
	json.Unmarshal(data, &decoded)
	s.inputs = append(s.inputs, decoded)
	if s.err != nil {
		return nil, s.err
	}
	if len(s.response) > 0 {
		return s.response, nil
	}
	return json.RawMessage(`{"draft":null}`), nil
}

func TestEngineeringClaimInstructions(t *testing.T) {
	for _, tc := range []struct {
		name       string
		response   json.RawMessage
		err        error
		configured bool
	}{
		{"configured", json.RawMessage(`{"configured":true}`), nil, true},
		{"unregistered", json.RawMessage(`{"configured":false}`), nil, false},
		{"unavailable", nil, errors.New("unavailable"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			runtimeID := dbfx.Runtime(t, "Engineering claim runtime")
			agentID := dbfx.Agent(t, "Engineering claim verifier", runtimeID)
			issueID := dbfx.Issue(t, "Engineering claim issue")
			taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "dispatched", "dispatched_at": testutil.Raw("now()")})
			task, err := testHandler.Queries.GetAgentTask(ctx, parseUUID(taskID))
			if err != nil {
				t.Fatal(err)
			}
			runtime, err := testHandler.Queries.GetAgentRuntime(ctx, parseUUID(runtimeID))
			if err != nil {
				t.Fatal(err)
			}
			h := *testHandler
			h.EngineeringWorker = &engineeringRecorder{response: tc.response, err: tc.err}
			response, _, _, _, _, failure := h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &task, runtime, runtimeID, testWorkspaceID)
			if tc.err != nil {
				if failure == nil {
					t.Fatal("unavailable role lookup did not stop claim")
				}
				current, err := h.Queries.GetAgentTask(ctx, task.ID)
				if err != nil {
					t.Fatal(err)
				}
				if current.Status != "failed" || current.FailureReason.String != "environment_prepare_failed" {
					t.Fatalf("wrong unavailable attribution: %s %s", current.Status, current.FailureReason.String)
				}
				return
			}
			if failure != nil {
				t.Fatalf("claim assembly failed: %+v", failure)
			}
			if response.Agent == nil || strings.Contains(response.Agent.Instructions, "multica engineering start") != tc.configured {
				t.Fatal("configured role did not receive command-chain instructions")
			}
		})
	}
}

func TestEngineeringApplicationActorBoundaries(t *testing.T) {
	_, token, _, agentID, issueID := engineeringRunFixture(t)
	h := *testHandler
	recorder := &engineeringRecorder{}
	h.EngineeringWorker = recorder
	user, err := h.Queries.GetUser(context.Background(), parseUUID(testUserID))
	if err != nil {
		t.Fatal(err)
	}
	session, err := h.issueJWT(user)
	if err != nil {
		t.Fatal(err)
	}
	request := func(credential, body string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/api/issues/"+issueID+"/engineering/verification/answers", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+credential)
		r.Header.Set("X-Workspace-ID", testWorkspaceID)
		return withURLParam(r, "id", issueID)
	}
	auth := func(handler http.HandlerFunc) http.HandlerFunc {
		return middleware.Auth(h.Queries, nil, nil, nil)(middleware.RequireWorkspaceMember(h.Queries)(handler)).ServeHTTP
	}
	testutil.Call(t, auth(h.AnswerEngineeringVerification), request(token, `{}`)).Want(http.StatusForbidden)
	testutil.Call(t, auth(h.ConfigureEngineeringVerification), request(token, `{}`)).Want(http.StatusForbidden)
	testutil.Call(t, auth(h.StartEngineeringVerification), request(session, `{}`)).Want(http.StatusForbidden)
	if len(recorder.inputs) != 0 {
		t.Fatal("machine/human boundary reached the worker")
	}
	testutil.Call(t, auth(h.AnswerEngineeringVerification), request(session, `{"expected_sequence":3,"request_id":"question","answer":"Ready"}`)).Want(http.StatusOK)
	actor := recorder.inputs[0]["actor"].(map[string]any)
	if actor["kind"] != "human" || actor["userId"] != testUserID || actor["issueId"] != issueID {
		t.Fatalf("human identity not derived from session: %+v", actor)
	}
	testutil.Call(t, auth(h.CommandEngineeringVerification), request(token, `{"expected_sequence":0,"command":{"type":"phase.complete"}}`)).Want(http.StatusOK)
	actor = recorder.inputs[1]["actor"].(map[string]any)
	if actor["kind"] != "task" || actor["agentId"] != agentID || actor["issueId"] != issueID || actor["attemptId"] == "" {
		t.Fatalf("task identity not derived from credential: %+v", actor)
	}
	testutil.Call(t, auth(h.ConfigureEngineeringVerification), request(session, `{"agent_id":"not-a-uuid"}`)).Want(http.StatusBadRequest)
	if len(recorder.inputs) != 2 {
		t.Fatal("invalid agent selection reached worker")
	}
}
