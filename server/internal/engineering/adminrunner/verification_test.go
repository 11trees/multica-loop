package adminrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

type verificationTestRPC struct {
	call func(any) (json.RawMessage, error)
}

func (p verificationTestRPC) Call(_ context.Context, input any) (json.RawMessage, error) {
	return p.call(input)
}
func TestVerificationSubmissionRequiresPrivateHostPreparationBeforeReply(t *testing.T) {
	for _, mode := range []string{"success", "unavailable", "store-error", "host-error", "deferred"} {
		t.Run(mode, func(t *testing.T) {
			calls, prepared := 0, 0
			identity := claim{CaseID: "original-case", AttemptID: "original-repair", Generation: 3, SessionID: "private-session", Authority: authority{OwnerID: "host", Token: 7}}
			r := &Runner{Client: verificationTestRPC{call: func(input any) (json.RawMessage, error) {
				calls++
				body := input.(map[string]any)
				if body["action"] != "command" || body["claim"].(claim) != identity {
					t.Fatal("submission moved to another private identity")
				}
				if mode == "store-error" {
					return nil, fmt.Errorf("invalid original references")
				}
				return json.RawMessage(`{"submitted":true,"agent_action":"end_execution"}`), nil
			}}}
			if mode != "unavailable" && mode != "deferred" {
				r.PrepareVerification = func(_ context.Context, raw json.RawMessage) error {
					prepared++
					var actual claim
					if json.Unmarshal(raw, &actual) != nil || actual != identity {
						t.Fatal("host preparation received provider payload instead of projected claim")
					}
					if mode == "host-error" {
						return fmt.Errorf("actual content changed")
					}
					return nil
				}
			}
			outcome := "verification-requested"
			if mode == "deferred" {
				outcome = "deferred"
			}
			raw, _ := json.Marshal(map[string]any{"action": "submit", "result": map[string]string{"outcome": outcome}})
			result, err := r.command(context.Background(), identity, raw)
			switch mode {
			case "success":
				if err != nil || calls != 1 || prepared != 1 || !json.Valid(result) {
					t.Fatal("verified host preparation did not precede reply", err)
				}
			case "unavailable":
				if err == nil || calls != 0 {
					t.Fatal("unavailable host accepted a request")
				}
			case "store-error":
				if err == nil || prepared != 0 {
					t.Fatal("invalid submission reached host preparation")
				}
			case "host-error":
				if err == nil || result != nil || prepared != 1 {
					t.Fatal("failed host preparation returned an accepted reply")
				}
			case "deferred":
				if err != nil || calls != 1 || prepared != 0 {
					t.Fatal("ordinary deferred receipt requires verification", err)
				}
			}
		})
	}
}
