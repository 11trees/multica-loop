// Package roleguidance supplies host-owned role practice for authenticated claims.
package roleguidance

import (
	"crypto/sha256"
	"embed"
	"fmt"
	"strings"
)

//go:embed instructions/*.md
var files embed.FS

var roles = map[string]string{
	"direct": "direct", "idea-context": "intent", "business-design": "business-design",
	"requirement-spec": "specification", "spec-review": "spec-review", "context": "context",
	"planning": "planning", "analysis": "analysis", "reproduction": "reproduction",
	"development": "development", "verification": "verification", "review": "review",
	"feedback-triage": "feedback-triage", "feedback-verify": "feedback-verify",
}

func read(name string) string {
	content, err := files.ReadFile("instructions/" + name + ".md")
	if err != nil {
		panic(err)
	}
	return strings.TrimSpace(string(content))
}

// Instructions selects by the kernel-authorized chain, never an editable Agent
// name. Report correction replaces ordinary Review practice rather than adding it.
func Instructions(chain string, reportCorrection bool) string {
	name, found := roles[chain]
	if !found {
		return ""
	}
	if chain == "review" && reportCorrection {
		name = "report-correction"
	}
	parts := []string{read("common")}
	if chain == "idea-context" || chain == "business-design" || chain == "context" || chain == "analysis" {
		parts = append(parts, read("decisions"))
	}
	parts = append(parts, read(name))
	content := strings.Join(parts, "\n\n")
	return fmt.Sprintf("## Engineering role practice v1\nRole: %s\nContent SHA-256: %x\n\n%s", name, sha256.Sum256([]byte(content)), content)
}
