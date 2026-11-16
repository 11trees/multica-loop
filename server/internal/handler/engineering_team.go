package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
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
				Workflow     string            `json:"workflow"`
				Roles        map[string]string `json:"roles"`
				DecisionMode string            `json:"decision_mode"`
				MaxReworks   *int              `json:"max_reworks"`
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
		request["payload"] = map[string]any{"expected_revision": *input.ExpectedRevision, "definition": map[string]any{"workflow": input.Definition.Workflow, "roles": resolved, "decision_mode": input.Definition.DecisionMode, "max_reworks": *input.Definition.MaxReworks}}
	}
	result, err := h.EngineeringWorker.Call(r.Context(), request)
	if err != nil {
		engineeringControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
