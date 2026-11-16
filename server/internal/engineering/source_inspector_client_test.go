package engineering

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestEngineeringSourceInspectorClientUsesIsolatedReadMode(t *testing.T) {
	root := t.TempDir()
	worker := filepath.Join(root, "worker.mjs")
	if err := os.WriteFile(worker, []byte(`process.stdout.write(JSON.stringify({result:{mode:process.argv[3],hasDatabaseCredential:!!process.env.DATABASE_URL,hasAgentCredential:!!process.env.MULTICA_TEST_AGENT_TOKEN}}));`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DATABASE_URL", "must-not-forward")
	t.Setenv("MULTICA_TEST_AGENT_TOKEN", "must-not-forward")
	client := Client{Worker: worker, Database: filepath.Join(root, "archive"), SourceInspector: true}
	raw, err := client.Call(context.Background(), map[string]any{"action": "inspect"})
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if json.Unmarshal(raw, &result) != nil || result["mode"] != "--source-inspect" || result["hasDatabaseCredential"] != false || result["hasAgentCredential"] != false {
		t.Fatal("source inspector leaked authority or used another mode", string(raw))
	}
	for _, other := range []Client{{Worker: worker, Database: root, SourceInspector: true, History: true}, {Worker: worker, Database: root, SourceInspector: true, Admin: true}} {
		if _, err := other.Call(context.Background(), nil); err == nil {
			t.Fatal("conflicting worker modes were accepted")
		}
	}
}
