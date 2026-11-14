package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func businessEngineeringChain(chain string) bool {
	return chain == "idea-context" || chain == "business-design" || chain == "requirement-spec" || chain == "spec-review"
}

func requireEngineeringProject(issue db.Issue, data json.RawMessage) error {
	var scope struct {
		Chain           string  `json:"chain"`
		ProjectID       *string `json:"business_project_id"`
		DirectProjectID *string `json:"direct_project_id"`
	}
	if json.Unmarshal(data, &scope) != nil {
		return &engineering.Rejection{Message: "invalid business project scope", Conflict: true}
	}
	if scope.Chain == "direct" || scope.DirectProjectID != nil {
		if scope.DirectProjectID == nil || !issue.ProjectID.Valid || *scope.DirectProjectID != uuidToString(issue.ProjectID) || issue.TriageState.Valid {
			return &engineering.Rejection{Message: "Direct must remain in its frozen accepted project", Conflict: true}
		}
	}
	if scope.ProjectID != nil || businessEngineeringChain(scope.Chain) {
		if scope.ProjectID == nil || !issue.ProjectID.Valid || *scope.ProjectID != uuidToString(issue.ProjectID) || issue.TriageState.Valid {
			return &engineering.Rejection{Message: "business analysis must remain in its frozen accepted project", Conflict: true}
		}
	}
	return nil
}

func (h *Handler) ConfigureEngineeringBusiness(w http.ResponseWriter, r *http.Request) {
	issue, userID, ok := h.loadHumanEngineeringIssue(w, r)
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		writeError(w, http.StatusServiceUnavailable, "engineering is not enabled")
		return
	}
	var input struct {
		ExpectedRevision int    `json:"expected_revision"`
		RepositoryPath   string `json:"repository_path"`
		Input            string `json:"input"`
		DecisionMode     string `json:"decision_mode"`
		AutoContinue     bool   `json:"auto_continue"`
		Roles            struct {
			Intent         string `json:"intent"`
			BusinessDesign string `json:"business_design"`
			Specification  string `json:"specification"`
			Review         string `json:"review"`
		} `json:"roles"`
		Delivery *struct {
			Roles      map[string]string `json:"roles"`
			MaxReworks int               `json:"max_reworks"`
		} `json:"delivery,omitempty"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.ExpectedRevision != 0 || strings.TrimSpace(input.Input) == "" || strings.TrimSpace(input.RepositoryPath) == "" {
		writeError(w, http.StatusBadRequest, "invalid business analysis configuration")
		return
	}
	if input.DecisionMode != "conservative" && input.DecisionMode != "balanced" && input.DecisionMode != "autonomous" && input.DecisionMode != "fully_autonomous" {
		writeError(w, http.StatusBadRequest, "invalid business decision mode")
		return
	}
	category, err := issuestatus.CategoryWithError(r.Context(), h.Queries, issue.WorkspaceID, issue.Status)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	if !issue.ProjectID.Valid || issue.TriageState.Valid || category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed {
		writeError(w, http.StatusConflict, "business analysis requires an open accepted project issue")
		return
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(r.Context(), issue.ID)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	if active {
		writeError(w, http.StatusConflict, "wait for the issue run to finish before configuring business analysis")
		return
	}
	resolved := make(map[string]string)
	resources := make([]map[string]string, 0, 4)
	roleInputs := []struct{ key, id string }{{"intent", input.Roles.Intent}, {"business_design", input.Roles.BusinessDesign}, {"specification", input.Roles.Specification}, {"review", input.Roles.Review}}
	if input.Delivery != nil {
		if !input.AutoContinue || input.Delivery.MaxReworks < 0 || input.Delivery.MaxReworks > 10 || len(input.Delivery.Roles) != 6 {
			writeError(w, http.StatusBadRequest, "End to End requires automatic continuation, six delivery roles and a bounded rework policy")
			return
		}
		for _, key := range []string{"context", "planner", "analyst", "developer", "verifier", "reviewer"} {
			if input.Delivery.Roles[key] == "" {
				writeError(w, http.StatusBadRequest, "missing End to End role")
				return
			}
			roleInputs = append(roleInputs, struct{ key, id string }{key, input.Delivery.Roles[key]})
		}
	}
	for _, role := range roleInputs {
		agent, ok := h.loadAgentForUser(w, r, role.id)
		if !ok {
			return
		}
		if !h.canInvokeAgent(r.Context(), agent, "member", userID, userID, uuidToString(issue.WorkspaceID)) {
			writeError(w, http.StatusForbidden, "business role is not invocable")
			return
		}
		mapping, err := h.engineeringExecutionResources(r.Context(), issue, agent)
		if err != nil {
			engineeringControlError(w, err)
			return
		}
		resources = append(resources, mapping...)
		resolved[role.key] = uuidToString(agent.ID)
	}
	payload := map[string]any{"expected_revision": input.ExpectedRevision, "project_id": uuidToString(issue.ProjectID), "repository_path": input.RepositoryPath, "input": input.Input,
		"decision_mode": input.DecisionMode, "auto_continue": input.AutoContinue, "execution_resources": resources}
	businessRoles := map[string]string{}
	for _, key := range []string{"intent", "business_design", "specification", "review"} {
		businessRoles[key] = resolved[key]
	}
	payload["roles"] = businessRoles
	if input.Delivery != nil {
		deliveryRoles := map[string]string{}
		for _, key := range []string{"context", "planner", "analyst", "developer", "verifier", "reviewer"} {
			deliveryRoles[key] = resolved[key]
		}
		payload["delivery"] = map[string]any{"roles": deliveryRoles, "maxReworks": input.Delivery.MaxReworks}
	}
	_, err = h.EngineeringWorker.Call(r.Context(), map[string]any{
		"action": "configure-business", "actor": map[string]string{"kind": "human", "userId": userID, "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID)},
		"payload": payload,
	})
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"configured": true})
}
