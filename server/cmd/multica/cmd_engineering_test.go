package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEngineeringCommandPreservesJSONEscapes(t *testing.T) {
	t.Chdir(t.TempDir())
	clearDaemonTaskEnv(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/engineering/verification/commands" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body struct {
			Command struct {
				Content string `json:"content"`
			} `json:"command"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Command.Content != "summary: 审查\nevidence: fixture" {
			t.Errorf("content was altered: %q", body.Command.Content)
		}
		fmt.Fprint(w, `{"draft":{"sequence":2}}`)
	}))
	defer server.Close()
	setCLITestServerEnv(t, server.URL)
	cmd, _, err := engineeringCmd.Find([]string{"command"})
	if err != nil {
		t.Fatal(err)
	}
	cmd.SetContext(context.Background())
	if err := cmd.Flags().Set("payload", `{"expected_sequence":1,"command":{"type":"artifact.put","ref":"verification.evidence-review","content":"summary: 审查\nevidence: fixture"}}`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Flags().Set("payload", "") })
	if _, err := captureStdout(t, func() error { return cmd.RunE(cmd, nil) }); err != nil {
		t.Fatal(err)
	}
}

func TestEngineeringPublicationUsesFrozenCheckpoint(t *testing.T) {
	t.Chdir(t.TempDir())
	clearDaemonTaskEnv(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/issues/parent/engineering/publication" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body map[string]int
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["expected_revision"] != 1 || body["expected_sequence"] != 9 {
			t.Error("publication checkpoint changed")
		}
		fmt.Fprint(w, `{"published":true}`)
	}))
	defer server.Close()
	setCLITestServerEnv(t, server.URL)
	cmd, _, err := engineeringCmd.Find([]string{"publish-units"})
	if err != nil {
		t.Fatal(err)
	}
	cmd.SetContext(context.Background())
	if err := cmd.Flags().Set("payload", `{"expected_revision":1,"expected_sequence":9}`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Flags().Set("payload", "") })
	if _, err := captureStdout(t, func() error { return cmd.RunE(cmd, []string{"parent"}) }); err != nil {
		t.Fatal(err)
	}
}

func TestEngineeringDeliveryAuthorizationUsesHumanEndpoint(t *testing.T) {
	t.Chdir(t.TempDir())
	clearDaemonTaskEnv(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/issues/parent/engineering/delivery" {
			t.Errorf("unexpected managed authorization endpoint: %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["max_reworks"] != float64(3) || body["expected_sequence"] != float64(17) {
			t.Error("authorization checkpoint changed")
		}
		fmt.Fprint(w, `{"authorized":true}`)
	}))
	defer server.Close()
	setCLITestServerEnv(t, server.URL)
	cmd, _, err := engineeringCmd.Find([]string{"start-deliveries"})
	if err != nil {
		t.Fatal(err)
	}
	cmd.SetContext(context.Background())
	cmd.Flags().Set("payload", `{"expected_revision":1,"expected_sequence":17,"analyst_agent_id":"analyst","developer_agent_id":"developer","agent_id":"verifier","max_reworks":3}`)
	t.Cleanup(func() { cmd.Flags().Set("payload", "") })
	if _, err := captureStdout(t, func() error { return cmd.RunE(cmd, []string{"parent"}) }); err != nil {
		t.Fatal(err)
	}
}

func TestEngineeringRequirementReviewCommandsUseHumanEndpoints(t *testing.T) {
	for _, operation := range []struct{ name, path, payload string }{
		{"acknowledge-specification", "/api/issues/parent/engineering/business-analysis/acknowledge", `{"expected_version":8,"draft_id":"review","specification_hash":"frozen"}`},
		{"comment-specification", "/api/issues/parent/engineering/business-analysis/comments", `{"request_id":"request","draft_id":"review","content":"Clarify"}`},
		{"configure-business", "/api/issues/parent/engineering/business-analysis", `{"expected_revision":0,"input":"Reader continues","roles":{"intent":"intent","business_design":"design","specification":"spec","review":"review"}}`},
		{"start-feedback", "/api/issues/parent/engineering/feedback", `{"expected_revision":1,"comment_ids":["comment"]}`},
		{"start-feedback-deliveries", "/api/issues/parent/engineering/feedback/work", `{"batch_id":"batch","expected_version":1,"planner_agent_id":"planner"}`},
		{"cancel-feedback", "/api/issues/parent/engineering/feedback/cancel", `{"expected_revision":1,"batch_id":"batch","expected_version":1,"reason":"Stop"}`},
		{"start-review", "/api/issues/parent/engineering/review", `{"expected_revision":1,"expected_sequence":17,"agent_id":"reviewer"}`},
		{"acknowledge-report", "/api/issues/parent/engineering/review/acknowledge", `{"expected_revision":1,"expected_sequence":25,"report_hash":"frozen-report"}`},
	} {
		t.Run(operation.name, func(t *testing.T) {
			t.Chdir(t.TempDir())
			clearDaemonTaskEnv(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != operation.path {
					t.Errorf("unexpected review endpoint: %s", r.URL.Path)
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				expected := map[string]any{}
				if err := json.Unmarshal([]byte(operation.payload), &expected); err != nil {
					t.Fatal(err)
				}
				actualJSON, _ := json.Marshal(body)
				expectedJSON, _ := json.Marshal(expected)
				if string(actualJSON) != string(expectedJSON) {
					t.Error("engineering payload changed")
				}
				fmt.Fprint(w, `{"ok":true}`)
			}))
			defer server.Close()
			setCLITestServerEnv(t, server.URL)
			cmd, _, err := engineeringCmd.Find([]string{operation.name})
			if err != nil {
				t.Fatal(err)
			}
			cmd.SetContext(context.Background())
			cmd.Flags().Set("payload", operation.payload)
			t.Cleanup(func() { cmd.Flags().Set("payload", "") })
			if _, err := captureStdout(t, func() error { return cmd.RunE(cmd, []string{"parent"}) }); err != nil {
				t.Fatal(err)
			}
		})
	}
}
