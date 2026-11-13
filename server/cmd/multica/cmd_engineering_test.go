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
