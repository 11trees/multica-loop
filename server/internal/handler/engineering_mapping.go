package handler

import (
	"context"
	"encoding/json"

	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (h *Handler) engineeringExecutionResources(ctx context.Context, issue db.Issue, agent db.Agent) ([]map[string]string, error) {
	reject := func(message string) ([]map[string]string, error) {
		return nil, &engineering.Rejection{Message: message, Conflict: true}
	}
	if !issue.ProjectID.Valid || !agent.RuntimeID.Valid {
		return reject("bind this issue to a project and choose a local runtime before starting engineering")
	}
	runtime, err := h.Queries.GetAgentRuntime(ctx, agent.RuntimeID)
	if err != nil {
		return nil, err
	}
	if runtime.WorkspaceID != issue.WorkspaceID || runtime.RuntimeMode != "local" || !runtime.DaemonID.Valid || runtime.DaemonID.String == "" {
		return reject("engineering requires a local runtime with a registered daemon")
	}
	resources, err := h.Queries.ListProjectResourcesInWorkspace(ctx, db.ListProjectResourcesInWorkspaceParams{ProjectID: issue.ProjectID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return nil, err
	}
	mappings := make([]map[string]string, 0)
	for _, resource := range resources {
		if resource.ResourceType != "local_directory" {
			continue
		}
		var ref localDirectoryRef
		if json.Unmarshal(resource.ResourceRef, &ref) != nil || ref.DaemonID != runtime.DaemonID.String {
			continue
		}
		mode := ref.ExecutionMode
		if mode == "" {
			mode = localDirectoryModeInPlace
		}
		mappings = append(mappings, map[string]string{"path": ref.LocalPath, "mode": mode})
	}
	if len(mappings) != 1 {
		return reject("bind one project directory to the selected runtime before starting engineering")
	}
	return mappings, nil
}
