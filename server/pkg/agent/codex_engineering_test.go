package agent

import (
	"fmt"
	"testing"
)

func TestCodexEngineeringCommandFacts(t *testing.T) {
	for _, tc := range []struct {
		status, exit string
		known        bool
		code         int64
	}{
		{"completed", "0", true, 0}, {"failed", "1", true, 1}, {"declined", "null", false, 0}, {"completed", "null", false, 0},
	} {
		t.Run(tc.status+tc.exit, func(t *testing.T) {
			c, _, _ := newTestCodexClient(t)
			c.notificationProtocol = "raw"
			var result *CommandResult
			c.onMessage = func(message Message) { result = message.CommandResult }
			c.handleLine(fmt.Sprintf(`{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"type":"commandExecution","id":"check","command":"npm test","cwd":"/fixture","status":%q,"exitCode":%s,"aggregatedOutput":"exit code 0"}}}`, tc.status, tc.exit))
			if result == nil || result.Status != tc.status || result.Command != "npm test" || result.Cwd != "/fixture" {
				t.Fatalf("missing native facts: %+v", result)
			}
			if (result.ExitCode != nil) != tc.known || result.ExitCode != nil && *result.ExitCode != tc.code {
				t.Fatalf("exit status was inferred from output: %+v", result)
			}
		})
	}
}
