package service

import (
	"encoding/json"
	"os"
	"testing"
)

func TestEngineeringRecoveryContextMatchesKernel(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/command-chain/test-helpers/repair-execution-hint.json")
	if err != nil {
		t.Fatal(err)
	}
	var hint EngineeringRecoveryExecution
	if err = json.Unmarshal(raw, &hint); err != nil {
		t.Fatal(err)
	}
	if err = hint.Validate(); err != nil {
		t.Fatal(err)
	}
	context, _ := json.Marshal(map[string]any{"head_sha": "preserved-native-context", "engineering_recovery": hint})
	stored, err := EngineeringRecoveryFromContext(context)
	if err != nil || stored == nil || stored.Hash != hint.Hash {
		t.Fatal("native recovery context lost its kernel identity", err)
	}
	for _, field := range []string{"stage", "sequence", "authority", "kind"} {
		t.Run(field, func(t *testing.T) {
			changed := hint
			switch field {
			case "stage":
				draft := "other-stage"
				changed.DraftID = &draft
			case "sequence":
				changed.Sequence++
			case "authority":
				changed.UserID = changed.AgentID
			case "kind":
				changed.Kind = "entry"
			}
			if changed.Validate() == nil {
				t.Fatal("substituted recovery context was accepted")
			}
		})
	}
	if _, err = EngineeringRecoveryFromContext([]byte(`{"engineering_recovery":{"hash":"forged"}}`)); err == nil {
		t.Fatal("malformed recovery context was accepted")
	}
	if value, e := EngineeringRecoveryFromContext([]byte(`{"head_sha":"ordinary"}`)); e != nil || value != nil {
		t.Fatal("ordinary native context became a recovery", e)
	}
}
