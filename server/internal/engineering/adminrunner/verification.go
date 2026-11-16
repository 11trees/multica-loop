package adminrunner

import (
	"context"
	"encoding/json"
	"fmt"
)

// A submission is a request, never a Test verdict. Complete host preparation
// before telling the provider to end its attempt; settlement still needs exit.
func (r *Runner) command(ctx context.Context, claim claim, payload json.RawMessage) (json.RawMessage, error) {
	var request struct {
		Action string `json:"action"`
		Result struct {
			Outcome string `json:"outcome"`
		} `json:"result"`
	}
	if err := json.Unmarshal(payload, &request); err != nil {
		return nil, err
	}
	workspace := request.Action == "workspace-write" || request.Action == "workspace-candidate"
	if workspace && r.RepairWorkspace == nil {
		return nil, fmt.Errorf("native repair workspace control is unavailable")
	}
	verification := request.Action == "submit" && request.Result.Outcome == "verification-requested"
	if verification && r.PrepareVerification == nil {
		return nil, fmt.Errorf("independent verification preparation is unavailable")
	}
	result, err := r.Client.Call(ctx, map[string]any{"action": "command", "claim": claim, "payload": payload})
	if err != nil {
		return nil, err
	}
	if workspace {
		identity, marshalErr := json.Marshal(claim)
		if marshalErr != nil {
			return nil, marshalErr
		}
		return r.RepairWorkspace(ctx, identity, payload)
	}
	if verification {
		identity, err := json.Marshal(claim)
		if err != nil {
			return nil, err
		}
		if err = r.PrepareVerification(ctx, identity); err != nil {
			return nil, err
		}
	}
	return result, nil
}
