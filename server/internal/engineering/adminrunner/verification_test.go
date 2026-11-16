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

func TestRepairWorkspaceCommandsRequireSuccessfulPrivateHostCallback(t *testing.T) {
	for _, action := range []string{"workspace-write", "workspace-candidate"} {
		for _, mode := range []string{"success", "unavailable", "store-error", "host-error"} {
			t.Run(action+"/"+mode, func(t *testing.T) {
				calls, hostCalls := 0, 0
				identity := claim{CaseID: "original", AttemptID: "repair", Generation: 2, SessionID: "projected", Authority: authority{OwnerID: "owner", Token: 3}}
				r := &Runner{Client: verificationTestRPC{call: func(input any) (json.RawMessage, error) {
					calls++
					body := input.(map[string]any)
					if body["claim"].(claim) != identity {
						t.Fatal("workspace identity changed")
					}
					if mode == "store-error" {
						return nil, fmt.Errorf("not owned")
					}
					return json.RawMessage(`{"host_required":true}`), nil
				}}}
				if mode != "unavailable" {
					r.RepairWorkspace = func(_ context.Context, raw, payload json.RawMessage) (json.RawMessage, error) {
						hostCalls++
						var actual claim
						if json.Unmarshal(raw, &actual) != nil || actual != identity {
							t.Fatal("host did not receive projected claim")
						}
						if mode == "host-error" {
							return nil, fmt.Errorf("native source revoked")
						}
						return json.RawMessage(`{"hash":"host-receipt"}`), nil
					}
				}
				result, err := r.command(context.Background(), identity, json.RawMessage(`{"action":"`+action+`"}`))
				if mode == "success" {
					if err != nil || string(result) != `{"hash":"host-receipt"}` || hostCalls != 1 {
						t.Fatal("workspace receipt was not host-authorized", err)
					}
				} else if err == nil || result != nil {
					t.Fatal("unverified workspace result escaped", mode)
				}
				if mode == "unavailable" && calls != 0 {
					t.Fatal("missing host accepted a command")
				}
				if mode == "store-error" && hostCalls != 0 {
					t.Fatal("invalid authority reached host")
				}
			})
		}
	}
}
