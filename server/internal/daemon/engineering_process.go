package daemon

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/engineering/processidentity"
)

// One journal is shared by sequential SDK launches and fresh-session retries.
// Each physical launch reserves a new ID before cmd.Start, not after a PID exists.
type engineeringProcessJournal struct {
	client       *Client
	task         Task
	ctx          context.Context
	allocationID string
	hostID       string
}

func (j *engineeringProcessJournal) beforeStart() error {
	j.allocationID = ""
	host, err := processidentity.HostID()
	if err != nil {
		return err
	}
	j.hostID = host
	j.allocationID = uuid.NewString()
	return j.record(j.ctx, map[string]any{"operation": "reserve"})
}
func (j *engineeringProcessJournal) started(pid int) error {
	marker, err := processidentity.Marker(pid)
	if err != nil {
		return err
	}
	if err = processidentity.ValidateGroup(pid); err != nil {
		return err
	}
	return j.record(j.ctx, map[string]any{"operation": "bind", "pid": pid, "marker": marker, "group_id": pid})
}
func (j *engineeringProcessJournal) exited(pid int, confirmed bool) error {
	if j.allocationID == "" {
		return nil
	}
	confirmed = confirmed && (pid == 0 || processidentity.GroupGone(pid))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return j.record(ctx, map[string]any{"operation": "exit", "pid": pid, "exit_confirmed": confirmed})
}
func (j *engineeringProcessJournal) record(ctx context.Context, payload map[string]any) error {
	payload["allocation_id"], payload["host_id"], payload["dispatched_at"] = j.allocationID, j.hostID, j.task.DispatchedAt
	var response struct {
		Reserved bool   `json:"reserved"`
		Bound    bool   `json:"bound"`
		Exited   bool   `json:"exited"`
		Status   string `json:"status"`
	}
	if err := j.client.postJSON(ctx, fmt.Sprintf("/api/daemon/tasks/%s/engineering-process", j.task.ID), payload, &response); err != nil {
		return err
	}
	switch payload["operation"] {
	case "reserve":
		if !response.Reserved || response.Status != "launching" {
			return fmt.Errorf("Native process reservation was not acknowledged")
		}
	case "bind":
		if !response.Bound {
			return fmt.Errorf("Native process identity was not acknowledged")
		}
	case "exit":
		if payload["exit_confirmed"] == true && !response.Exited {
			return fmt.Errorf("Native process exit was not acknowledged")
		}
	}
	return nil
}
