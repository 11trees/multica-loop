package handler

import (
	"context"
	"encoding/json"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/projectaccess"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

var engineeringTeamRoles = map[string][]string{
	"direct":            {"executor"},
	"business_analysis": {"intent", "business_design", "specification", "review"},
	"end_to_end":        {"intent", "business_design", "specification", "review", "context", "planner", "analyst", "developer", "verifier", "reviewer"},
	"develop":           {"context", "planner", "analyst", "developer", "verifier", "reviewer"},
	"bug_fix":           {"reproducer", "context", "planner", "analyst", "developer", "verifier", "reviewer"},
}

func (h *Handler) EngineeringTeamProfile(w http.ResponseWriter, r *http.Request) {
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "a human actor is required")
		return
	}
	squad, workspace, ok := h.loadSquadInWorkspace(w, r)
	if !ok {
		return
	}
	member, ok := h.requireWorkspaceMember(w, r, workspace, "workspace not found")
	if !ok {
		return
	}
	if h.EngineeringWorker == nil {
		if r.Method == http.MethodGet {
			writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "profile": nil})
			return
		}
		writeError(w, http.StatusServiceUnavailable, "engineering is not enabled")
		return
	}
	actor := map[string]string{"kind": "team-manager", "workspaceId": workspace, "teamId": uuidToString(squad.ID), "userId": uuidToString(member.UserID)}
	request := map[string]any{"action": "team-profile", "actor": actor}
	if r.Method == http.MethodPut {
		if !canManageSquad(member, squad) {
			writeError(w, http.StatusForbidden, "insufficient permissions")
			return
		}
		if squad.ArchivedAt.Valid {
			writeError(w, http.StatusConflict, "archived Teams cannot change their workflow")
			return
		}
		var input struct {
			ExpectedRevision *int `json:"expected_revision"`
			Definition       struct {
				Workflow     string                   `json:"workflow"`
				Roles        map[string]string        `json:"roles"`
				DecisionMode string                   `json:"decision_mode"`
				MaxReworks   *int                     `json:"max_reworks"`
				Feedback     *engineeringTeamFeedback `json:"feedback,omitempty"`
			} `json:"definition"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.ExpectedRevision == nil || *input.ExpectedRevision < 0 || input.Definition.MaxReworks == nil || *input.Definition.MaxReworks < 0 || *input.Definition.MaxReworks > 10 {
			writeError(w, http.StatusBadRequest, "invalid Team workflow definition")
			return
		}
		required, known := engineeringTeamRoles[input.Definition.Workflow]
		if !known || len(input.Definition.Roles) != len(required) {
			writeError(w, http.StatusBadRequest, "choose the Agents required by this workflow")
			return
		}
		if workflow := builtinEngineeringWorkflow(workspace, uuidToString(squad.ID)); workflow != "" && input.Definition.Workflow != workflow {
			writeError(w, http.StatusBadRequest, "a built-in Team retains its predefined workflow")
			return
		}
		switch input.Definition.DecisionMode {
		case "conservative", "balanced", "autonomous", "fully_autonomous":
		default:
			writeError(w, http.StatusBadRequest, "invalid decision policy")
			return
		}
		members, err := h.Queries.ListSquadMembers(r.Context(), squad.ID)
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "Team members unavailable")
			return
		}
		roster := map[string]bool{uuidToString(squad.LeaderID): true}
		for _, entry := range members {
			if entry.MemberType == "agent" {
				roster[uuidToString(entry.MemberID)] = true
			}
		}
		resolved := map[string]string{}
		used := map[string]bool{}
		for _, role := range required {
			id := strings.TrimSpace(input.Definition.Roles[role])
			if id == "" || !roster[id] || used[id] {
				writeError(w, http.StatusBadRequest, "workflow roles must use distinct Agent members of this Team")
				return
			}
			agent, ok := h.loadAgentForUser(w, r, id)
			if !ok {
				return
			}
			if agent.ArchivedAt.Valid || !h.memberCanWireAgent(r.Context(), member, agent, workspace) {
				writeError(w, http.StatusForbidden, "Team role Agent is not available")
				return
			}
			used[id] = true
			resolved[role] = uuidToString(agent.ID)
		}
		definition := map[string]any{"workflow": input.Definition.Workflow, "roles": resolved, "decision_mode": input.Definition.DecisionMode, "max_reworks": *input.Definition.MaxReworks}
		if feedback := input.Definition.Feedback; feedback != nil {
			if !feedback.valid(input.Definition.Workflow, resolved) {
				writeError(w, http.StatusBadRequest, "Feedback roles must preserve independent verification and forward work")
				return
			}
			for _, id := range feedback.ids() {
				if !roster[id] {
					writeError(w, http.StatusBadRequest, "Feedback roles must be Agent members of this Team")
					return
				}
				agent, ok := h.loadAgentForUser(w, r, id)
				if !ok {
					return
				}
				if agent.ArchivedAt.Valid || !h.memberCanWireAgent(r.Context(), member, agent, workspace) {
					writeError(w, http.StatusForbidden, "Feedback role Agent is not available")
					return
				}
			}
			definition["feedback"] = feedback
		}
		request["payload"] = map[string]any{"expected_revision": *input.ExpectedRevision, "definition": definition}
	}
	result, err := h.EngineeringWorker.Call(r.Context(), request)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	if workflow := builtinEngineeringWorkflow(workspace, uuidToString(squad.ID)); workflow != "" {
		var response map[string]any
		if err := json.Unmarshal(result, &response); err != nil || response == nil {
			writeError(w, http.StatusServiceUnavailable, "Team definition unavailable")
			return
		}
		response["builtin_workflow"] = workflow
		writeJSON(w, http.StatusOK, response)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type engineeringTeamDefinition struct {
	Workflow     string                   `json:"workflow"`
	Roles        map[string]string        `json:"roles"`
	DecisionMode string                   `json:"decision_mode"`
	MaxReworks   int                      `json:"max_reworks"`
	Feedback     *engineeringTeamFeedback `json:"feedback,omitempty"`
}
type engineeringTeamFeedback struct {
	Triager    string `json:"triager"`
	Verifier   string `json:"verifier"`
	Planner    string `json:"planner"`
	Reproducer string `json:"reproducer"`
}

func (f engineeringTeamFeedback) ids() []string {
	return []string{f.Triager, f.Verifier, f.Planner, f.Reproducer}
}
func (f engineeringTeamFeedback) valid(workflow string, roles map[string]string) bool {
	if workflow != "develop" && workflow != "bug_fix" && workflow != "end_to_end" {
		return false
	}
	for _, id := range f.ids() {
		if _, err := util.ParseUUID(id); err != nil {
			return false
		}
		if id == roles["analyst"] || id == roles["developer"] || id == roles["verifier"] {
			return false
		}
	}
	return f.Verifier != roles["reviewer"] && f.Triager != f.Verifier && f.Planner != f.Verifier && f.Reproducer != f.Verifier && f.Planner != f.Reproducer
}

type engineeringTeamSnapshot struct {
	TeamID      string                    `json:"teamId"`
	WorkspaceID string                    `json:"workspaceId"`
	Revision    int                       `json:"revision"`
	Definition  engineeringTeamDefinition `json:"definition"`
}
type engineeringTeamBinding struct {
	ID        string                  `json:"id"`
	IssueID   string                  `json:"issueId"`
	ProjectID string                  `json:"projectId"`
	StartedBy string                  `json:"startedBy"`
	Input     string                  `json:"input"`
	Profile   engineeringTeamSnapshot `json:"profile"`
}
type engineeringTeamRouting struct {
	Owned   bool                     `json:"owned"`
	Binding *engineeringTeamBinding  `json:"binding"`
	Profile *engineeringTeamSnapshot `json:"profile"`
}

func (h *Handler) frozenEngineeringTeamFeedback(ctx context.Context, issue db.Issue, user string) (*engineeringTeamFeedback, error) {
	if issue.AssigneeType.String != "squad" {
		return nil, nil
	}
	routing, err := h.engineeringTeamRouting(ctx, issue)
	if err != nil {
		return nil, err
	}
	if routing.Binding == nil {
		if routing.Owned {
			return nil, &engineering.Rejection{Message: "Start the task with its Team before processing feedback", Conflict: true}
		}
		return nil, nil
	}
	binding := routing.Binding
	if binding.IssueID != uuidToString(issue.ID) || binding.StartedBy != user || binding.Profile.TeamID != uuidToString(issue.AssigneeID) || binding.ProjectID != uuidToString(issue.ProjectID) || binding.Input != strings.TrimSpace(issue.Title+"\n\n"+issue.Description.String) {
		return nil, &engineering.Rejection{Message: "Feedback retains its frozen Team, project, goal and human authority", Conflict: true}
	}
	if binding.Profile.Definition.Feedback == nil {
		return nil, &engineering.Rejection{Message: "This task's frozen Team version has no Feedback policy", Conflict: true}
	}
	return binding.Profile.Definition.Feedback, nil
}

func (h *Handler) rejectTeamTaskConfiguration(w http.ResponseWriter, r *http.Request, issue db.Issue) bool {
	if h.EngineeringWorker == nil || issue.AssigneeType.String != "squad" {
		return false
	}
	routing, err := h.engineeringTeamRouting(r.Context(), issue)
	if err != nil {
		engineeringControlError(w, err)
		return true
	}
	if routing.Owned {
		writeError(w, http.StatusConflict, "This task uses its Team workflow; configure roles and policy on the Team.")
		return true
	}
	return false
}

func (h *Handler) requireFrozenTeamUpdate(ctx context.Context, workspaceID string, params db.UpdateIssueParams) error {
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: params.ID, WorkspaceID: parseUUID(workspaceID)})
	if err != nil {
		return err
	}
	if issue.AssigneeType.String != "squad" {
		return nil
	}
	routing, err := h.engineeringTeamRouting(ctx, issue)
	if err != nil {
		return &engineeringCompletionError{message: "Team binding lookup is unavailable", unavailable: true}
	}
	binding := routing.Binding
	if binding == nil || binding.IssueID != uuidToString(issue.ID) {
		return nil
	}
	title, description := issue.Title, issue.Description.String
	if params.Title.Valid {
		title = params.Title.String
	}
	if params.Description.Valid {
		description = params.Description.String
	}
	if strings.TrimSpace(title+"\n\n"+description) != binding.Input || uuidToString(params.ProjectID) != binding.ProjectID || params.AssigneeType.String != "squad" || uuidToString(params.AssigneeID) != binding.Profile.TeamID {
		return &engineeringCompletionError{message: "This task has started with a frozen Team, project and goal. Add new information in comments; create a new task to change its scope."}
	}
	return nil
}

func (h *Handler) engineeringTeamRouting(ctx context.Context, issue db.Issue) (engineeringTeamRouting, error) {
	var routing engineeringTeamRouting
	if h.EngineeringWorker == nil {
		return routing, nil
	}
	payload := map[string]string{}
	if issue.CreatedAt.Valid {
		payload["created_at"] = issue.CreatedAt.Time.UTC().Format(time.RFC3339Nano)
	}
	if issue.AssigneeType.Valid && issue.AssigneeType.String == "squad" && issue.AssigneeID.Valid {
		payload["team_id"] = uuidToString(issue.AssigneeID)
	}
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "team-routing", "actor": map[string]string{"kind": "host", "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID)}, "payload": payload})
	if err != nil {
		return routing, err
	}
	err = json.Unmarshal(data, &routing)
	return routing, err
}
func (h *Handler) StartEngineeringTeam(w http.ResponseWriter, r *http.Request) {
	issue, user, ok := h.loadHumanEngineeringIssue(w, r)
	if !ok {
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	var input struct{}
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		writeError(w, http.StatusBadRequest, "task start takes no per-task execution settings")
		return
	}
	if err := h.startEngineeringTeamIssue(r.Context(), issue, user); err != nil {
		engineeringControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"started": true})
}
func (h *Handler) startEngineeringTeamIssue(ctx context.Context, issue db.Issue, user string) error {
	reject := func(message string) error { return &engineering.Rejection{Message: message, Conflict: true} }
	if h.EngineeringWorker == nil || !issue.ProjectID.Valid || issue.TriageState.Valid || issue.AssigneeType.String != "squad" || !issue.AssigneeID.Valid {
		return reject("choose a Team and an accepted project before starting")
	}
	held, err := h.Queries.EngineeringHistoryProjectHeld(ctx, issue.ProjectID)
	if err != nil {
		return err
	}
	if held {
		return reject("LoopWork cutover holds this project; finish or roll back the cutover before starting")
	}
	category, err := issuestatus.CategoryWithError(ctx, h.Queries, issue.WorkspaceID, issue.Status)
	if err != nil {
		return err
	}
	if category == issuestatus.CategoryDone || category == issuestatus.CategoryClosed || issue.Status == issuestatus.Backlog {
		return reject("start an open accepted task rather than a draft")
	}
	userID, err := util.ParseUUID(user)
	if err != nil {
		return err
	}
	member, err := h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: userID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return err
	}
	access, err := projectaccess.ForMember(ctx, h.Queries, issue.WorkspaceID, userID, member.Role)
	if err != nil {
		return err
	}
	if !access.CanSeeProject(issue.ProjectID) {
		return reject("project is no longer accessible")
	}
	squad, err := h.Queries.GetSquadInWorkspace(ctx, db.GetSquadInWorkspaceParams{ID: issue.AssigneeID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return err
	}
	if squad.ArchivedAt.Valid {
		return reject("Team is archived")
	}
	routing, err := h.engineeringTeamRouting(ctx, issue)
	if err != nil {
		return err
	}
	profile := routing.Profile
	input := strings.TrimSpace(issue.Title + "\n\n" + issue.Description.String)
	if routing.Binding != nil {
		binding := routing.Binding
		if binding.Profile.TeamID != uuidToString(squad.ID) || binding.ProjectID != uuidToString(issue.ProjectID) || binding.StartedBy != user || binding.Input != input {
			return reject("task retains its original Team, goal, project and human authorization")
		}
		profile = &binding.Profile
	}
	if profile == nil {
		return reject("set this Team's predefined workflow before starting")
	}
	if profile.TeamID != uuidToString(squad.ID) || profile.WorkspaceID != uuidToString(issue.WorkspaceID) || profile.Revision < 1 || len(engineeringTeamRoles[profile.Definition.Workflow]) == 0 {
		return reject("Team definition scope is unavailable")
	}

	members, err := h.Queries.ListSquadMembers(ctx, squad.ID)
	if err != nil {
		return err
	}
	roster := map[string]bool{uuidToString(squad.LeaderID): true}
	for _, m := range members {
		if m.MemberType == "agent" {
			roster[uuidToString(m.MemberID)] = true
		}
	}
	resources := []map[string]string{}
	path := ""
	mode := ""
	baseRoles := engineeringTeamRoles[profile.Definition.Workflow]
	roleIDs := make([]string, 0, len(baseRoles)+4)
	for _, role := range baseRoles {
		roleIDs = append(roleIDs, profile.Definition.Roles[role])
	}
	if profile.Definition.Feedback != nil {
		roleIDs = append(roleIDs, profile.Definition.Feedback.ids()...)
	}
	for index, roleID := range roleIDs {
		id, err := util.ParseUUID(roleID)
		if err != nil {
			return err
		}
		if routing.Binding == nil && !roster[uuidToString(id)] {
			return reject("Team workflow references an Agent outside its current members")
		}
		agent, err := h.Queries.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: id, WorkspaceID: issue.WorkspaceID})
		if err != nil {
			return err
		}
		if agent.ArchivedAt.Valid || !h.canInvokeAgent(ctx, agent, "member", user, user, uuidToString(issue.WorkspaceID)) {
			return reject("a frozen Team role is no longer invocable")
		}
		mapping, err := h.engineeringExecutionResources(ctx, issue, agent)
		if err != nil {
			return err
		}
		canonical, err := filepath.EvalSymlinks(mapping[0]["path"])
		if err != nil {
			return reject("project repository is unavailable")
		}
		if path == "" {
			path = canonical
			mode = mapping[0]["mode"]
		}
		if path != canonical || mode != mapping[0]["mode"] {
			return reject("Team roles must map to the same project repository and mode")
		}
		if index < len(baseRoles) {
			resources = append(resources, map[string]string{"path": canonical, "mode": mode})
		}
	}
	active, err := h.Queries.HasUnfinishedEngineeringIssueTask(ctx, issue.ID)
	if err != nil {
		return err
	}
	if active {
		if routing.Binding != nil {
			return nil
		}
		return reject("wait for current execution cleanup before handing this task to its Team")
	}
	_, err = h.EngineeringWorker.Call(ctx, map[string]any{"action": "team-start", "actor": map[string]string{"kind": "human", "workspaceId": uuidToString(issue.WorkspaceID), "issueId": uuidToString(issue.ID), "userId": user}, "payload": map[string]any{"team_id": uuidToString(squad.ID), "team_revision": profile.Revision, "project_id": uuidToString(issue.ProjectID), "input": input, "repository_path": path, "execution_resources": resources}})
	if err != nil {
		return err
	}
	data, err := h.EngineeringWorker.Call(ctx, map[string]any{"action": "continuations", "actor": map[string]string{"kind": "coordinator"}})
	if err != nil {
		return err
	}
	var pending []engineeringContinuation
	if err = json.Unmarshal(data, &pending); err != nil {
		return err
	}
	for _, item := range pending {
		if item.WorkspaceID == uuidToString(issue.WorkspaceID) && item.IssueID == uuidToString(issue.ID) {
			if err = h.dispatchEngineeringContinuation(ctx, item); err != nil {
				return err
			}
		}
	}
	return nil
}

func (h *Handler) requireFrozenTeamContinuation(ctx context.Context, item engineeringContinuation) error {
	if h.EngineeringWorker == nil {
		return nil
	}
	workspace, err := util.ParseUUID(item.WorkspaceID)
	if err != nil {
		return err
	}
	id, err := util.ParseUUID(item.IssueID)
	if err != nil {
		return err
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: workspace, ID: id})
	if err != nil {
		return err
	}
	routing, err := h.engineeringTeamRouting(ctx, issue)
	if err != nil {
		return err
	}
	if routing.Binding == nil {
		return nil
	}
	binding := routing.Binding
	rootID, err := util.ParseUUID(binding.IssueID)
	if err != nil {
		return err
	}
	root, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: workspace, ID: rootID})
	if err != nil {
		return err
	}
	if root.AssigneeType.String != "squad" || uuidToString(root.AssigneeID) != binding.Profile.TeamID || uuidToString(root.ProjectID) != binding.ProjectID || binding.Input != strings.TrimSpace(root.Title+"\n\n"+root.Description.String) || item.UserID != binding.StartedBy {
		return &engineering.Rejection{Message: "Team task origin or frozen human authority changed", Conflict: true}
	}
	return nil
}
