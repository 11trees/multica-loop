package roleguidance

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"
)

func TestRolePracticeHasVersionedContentAndDistinctNativeRoles(t *testing.T) {
	seen := map[string]bool{}
	for _, chain := range []string{"direct", "idea-context", "business-design", "requirement-spec", "spec-review", "context", "planning", "analysis", "reproduction", "development", "verification", "review", "feedback-triage", "feedback-verify"} {
		instruction := Instructions(chain, false)
		parts := strings.SplitN(instruction, "\n\n", 2)
		if len(parts) != 2 || !strings.Contains(parts[0], "Engineering role practice v1") || !strings.Contains(parts[0], fmt.Sprintf("Content SHA-256: %x", sha256.Sum256([]byte(parts[1])))) || seen[instruction] {
			t.Fatalf("role %s lacks its distinct, auditable instruction body", chain)
		}
		seen[instruction] = true
	}
	if Instructions("unknown", false) != "" || Instructions("", false) != "" {
		t.Fatal("an unconfigured role acquired workflow authority")
	}
}

func TestReportCorrectionReplacesOrdinaryReviewAndDecisionsStayRoleScoped(t *testing.T) {
	correction := Instructions("review", true)
	if !strings.Contains(correction, "exact candidate") || strings.Contains(correction, "First establish a complete requirement-level fact chain") || strings.Contains(correction, "record accurate scope") || strings.Contains(correction, "Establish a complete Design Tree") {
		t.Fatal("report expression correction inherited ordinary closure or decision authority")
	}
	for _, chain := range []string{"idea-context", "business-design", "context", "analysis"} {
		if !strings.Contains(Instructions(chain, false), "A frontier is every node") {
			t.Fatalf("%s lost complete frontier/answer-review practice", chain)
		}
	}
	for _, chain := range []string{"direct", "planning", "verification", "feedback-verify"} {
		if strings.Contains(Instructions(chain, false), "A frontier is every node") {
			t.Fatalf("%s inherited a product decision role", chain)
		}
	}
}
