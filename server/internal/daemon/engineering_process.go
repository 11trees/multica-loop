package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/engineering/processidentity"
)

// One journal is shared by sequential SDK launches and fresh-session retries.
// Each physical launch reserves a new ID before cmd.Start, not after a PID exists.
type engineeringProcessJournal struct {
	client          *Client
	task            Task
	ctx             context.Context
	allocationID    string
	hostID          string
	controllerID    string
	provider        string
	startedProvider atomic.Bool
	invoked         atomic.Bool
}

func (j *engineeringProcessJournal) begin(ctx context.Context) error {
	j.controllerID = uuid.NewString()
	host, err := processidentity.HostID()
	if err != nil {
		return err
	}
	j.hostID = host
	marker, err := processidentity.Marker(os.Getpid())
	if err != nil {
		return err
	}
	waitRecorded := false
	for {
		var response struct {
			Admitted          bool `json:"admitted"`
			WaitingRepository bool `json:"waiting_repository"`
		}
		payload := map[string]any{"operation": "begin", "controller_id": j.controllerID, "dispatched_at": j.task.DispatchedAt, "host_id": j.hostID, "provider": j.provider, "pid": os.Getpid(), "marker": marker}
		if err := j.client.postJSON(ctx, fmt.Sprintf("/api/daemon/tasks/%s/engineering-controller", j.task.ID), payload, &response); err != nil {
			return err
		}
		if response.Admitted {
			return nil
		}
		if !response.WaitingRepository {
			return fmt.Errorf("Native controller admission was not acknowledged")
		}
		reason := j.task.ProjectTitle
		if reason == "" {
			reason = "project repository"
		}
		if !waitRecorded {
			// This is a display hint and may already be recorded by the local
			// path waiter. The next admission still validates the exact claim.
			_ = j.client.MarkTaskWaitingLocalDirectory(ctx, j.task.ID, reason)
			if ctx.Err() != nil {
				return ctx.Err()
			}
			waitRecorded = true
		}
		timer := time.NewTimer(500 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
func (j *engineeringProcessJournal) workspace(path, mode string) error {
	return j.control(j.ctx, map[string]any{"operation": "workspace", "workspace_path": path, "mode": mode}, "bound")
}
func (j *engineeringProcessJournal) end() error {
	if j.controllerID == "" || j.hostID == "" {
		return nil
	}
	noProvider := !j.invoked.Load()
	if j.provider == "codex" {
		noProvider = !j.startedProvider.Load()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var response struct {
		Recorded bool `json:"recorded"`
		Quiesced bool `json:"quiesced"`
	}
	payload := map[string]any{"operation": "end", "controller_id": j.controllerID, "host_id": j.hostID, "dispatched_at": j.task.DispatchedAt, "no_provider_started": noProvider}
	if err := j.client.postJSON(ctx, fmt.Sprintf("/api/daemon/tasks/%s/engineering-controller", j.task.ID), payload, &response); err != nil {
		return err
	}
	if !response.Recorded || j.provider == "codex" && !response.Quiesced {
		return fmt.Errorf("Native controller cleanup was not acknowledged")
	}
	return nil
}
func (j *engineeringProcessJournal) control(ctx context.Context, payload map[string]any, key string) error {
	payload["controller_id"], payload["host_id"], payload["dispatched_at"] = j.controllerID, j.hostID, j.task.DispatchedAt
	var response map[string]json.RawMessage
	if err := j.client.postJSON(ctx, fmt.Sprintf("/api/daemon/tasks/%s/engineering-controller", j.task.ID), payload, &response); err != nil {
		return err
	}
	var ack bool
	if json.Unmarshal(response[key], &ack) != nil || !ack {
		return fmt.Errorf("Native controller operation was not acknowledged")
	}
	return nil
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
	j.startedProvider.Store(true)
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
	if pid > 0 {
		j.startedProvider.Store(true)
	}
	if j.allocationID == "" {
		return nil
	}
	confirmed = confirmed && (pid == 0 || processidentity.GroupGone(pid))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return j.record(ctx, map[string]any{"operation": "exit", "pid": pid, "exit_confirmed": confirmed})
}
func (j *engineeringProcessJournal) record(ctx context.Context, payload map[string]any) error {
	operation := payload["operation"].(string)
	payload["operation"] = "process-" + operation
	payload["controller_id"] = j.controllerID
	payload["allocation_id"], payload["host_id"], payload["dispatched_at"] = j.allocationID, j.hostID, j.task.DispatchedAt
	var response struct {
		Reserved bool   `json:"reserved"`
		Bound    bool   `json:"bound"`
		Exited   bool   `json:"exited"`
		Status   string `json:"status"`
	}
	if err := j.client.postJSON(ctx, fmt.Sprintf("/api/daemon/tasks/%s/engineering-controller", j.task.ID), payload, &response); err != nil {
		return err
	}
	switch operation {
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
