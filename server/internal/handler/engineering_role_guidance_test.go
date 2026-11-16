package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/engineering/roleguidance"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestEngineeringClaimsSelectRolePracticeWithoutRewritingAgentInstructions(t *testing.T) {
	ctx := context.Background()
	runtimeID := dbfx.Runtime(t, "Role practice fixture")
	notes := "Keep these workspace-authored notes."
	agentID := dbfx.Agent(t, "Editable name suggests a different role", runtimeID, testutil.Cols{"instructions": notes})
	projectID := dbfx.Project(t, "Role practice project")
	issueID := dbfx.Issue(t, "Role practice parent", testutil.Cols{"project_id": projectID})
	planID, contract := uuidToString(dbid.NewV7()), strings.Repeat("b", 64)
	metadata, _ := json.Marshal(map[string]any{"engineering.plan": planID, "engineering.unit": "unit", "engineering.revision": 1, "engineering.contract": contract})
	childID := dbfx.Issue(t, "Accepted scope", testutil.Cols{"project_id": projectID, "parent_issue_id": issueID, "status": "done", "metadata": json.RawMessage(metadata)})
	runtime, err := testHandler.Queries.GetAgentRuntime(ctx, parseUUID(runtimeID))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		chain      string
		correction bool
	}{{"direct", false}, {"idea-context", false}, {"business-design", false}, {"requirement-spec", false}, {"spec-review", false}, {"context", false}, {"planning", false}, {"analysis", false}, {"reproduction", false}, {"development", false}, {"verification", false}, {"review", false}, {"review", true}, {"feedback-triage", false}, {"feedback-verify", false}, {"", false}}
	for _, tc := range cases {
		name := tc.chain
		if tc.correction {
			name += "-correction"
		}
		t.Run(name, func(t *testing.T) {
			taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "dispatched", "dispatched_at": testutil.Raw("now()")})
			task, err := testHandler.Queries.GetAgentTask(ctx, parseUUID(taskID))
			if err != nil {
				t.Fatal(err)
			}
			selection := map[string]any{"configured": tc.chain != "", "chain": tc.chain, "repository_path": "/fixture/repository", "code_version": strings.Repeat("a", 40), "report_correction": tc.correction, "review_units": []engineeringReviewUnit{{IssueID: childID, PlanDraftID: planID, UnitKey: "unit", ParentRevision: 1, ContractHash: contract}}}
			if businessEngineeringChain(tc.chain) {
				selection["business_project_id"] = projectID
			}
			if tc.chain == "direct" {
				selection["direct_project_id"] = projectID
			}
			data, _ := json.Marshal(selection)
			h := *testHandler
			h.EngineeringWorker = &engineeringRecorder{response: data}
			response, _, _, _, _, failure := h.buildClaimedTaskResponse(newRequest(http.MethodPost, "/claim", nil), &task, runtime, runtimeID, testWorkspaceID)
			if failure != nil || response.Agent == nil || !strings.HasPrefix(response.Agent.Instructions, notes) {
				t.Fatalf("claim lost original notes or native scope: %+v", failure)
			}
			if tc.chain == "" {
				if response.Agent.Instructions != notes {
					t.Fatal("an ordinary issue inherited an engineering role")
				}
			} else if !strings.Contains(response.Agent.Instructions, roleguidance.Instructions(tc.chain, tc.correction)) || strings.Count(response.Agent.Instructions, "## Engineering role practice v1") != 1 {
				t.Fatal("claim did not retain the exact current authenticated role practice")
			}
			if tc.correction && strings.Contains(response.Agent.Instructions, "First establish a complete requirement-level fact chain") {
				t.Fatal("report correction inherited ordinary Review authority")
			}
			dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", taskID)
		})
	}
	var saved string
	if err := testPool.QueryRow(ctx, "SELECT instructions FROM agent WHERE id=$1", agentID).Scan(&saved); err != nil || saved != notes {
		t.Fatal("claim composition rewrote stored Agent instructions", err)
	}
}
