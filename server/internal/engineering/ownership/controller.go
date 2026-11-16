// Package ownership binds native preparation, provider processes and repair fences.
package ownership

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var ErrConflict = errors.New("engineering ownership changed")

func conflict(message string) error { return fmt.Errorf("%w: %s", ErrConflict, message) }
func IsConflict(err error) bool {
	var database *pgconn.PgError
	return errors.Is(err, ErrConflict) || errors.Is(err, pgx.ErrNoRows) || (errors.As(err, &database) && (database.Code == "55000" && database.Message == "engineering repair owns this project" || database.Code == "23505" && strings.HasPrefix(database.ConstraintName, "engineering_")))
}
func IsProjectBusy(err error) bool {
	var database *pgconn.PgError
	return errors.As(err, &database) && database.Code == "23505" && database.ConstraintName == "engineering_project_execution_live_idx"
}

type TxStarter interface {
	Begin(context.Context) (pgx.Tx, error)
}
type Store struct {
	Queries      *db.Queries
	Transactions TxStarter
}
type ControllerRequest struct {
	ControllerID                                             pgtype.UUID
	AllocationID                                             pgtype.UUID
	Operation, Provider, HostID, Marker, WorkspacePath, Mode string
	PID, GroupID                                             int64
	Confirmed, NoProviderStarted                             *bool
}

func controllerProcessFacts(processes []db.EngineeringRunProcess) (allExited, started bool) {
	allExited = true
	for _, process := range processes {
		allExited = allExited && process.Phase == "exited"
		started = started || process.Pid.Valid && process.Pid.Int64 > 0 || process.ExitPid.Valid && process.ExitPid.Int64 > 0
	}
	return allExited, started
}

// ControllerCleanupConfirmed checks the saved final receipt against physical identities.
func ControllerCleanupConfirmed(guard db.EngineeringRunGuard, processes []db.EngineeringRunProcess) bool {
	if !guard.NoProviderStarted.Valid {
		return false
	}
	allExited, started := controllerProcessFacts(processes)
	if guard.NoProviderStarted.Bool {
		return allExited && !started
	}
	return allExited && guard.Provider == "codex" && started
}

// RecordController accepts projected native identity, never a model credential.
func (s Store) RecordController(ctx context.Context, task db.AgentTaskQueue, workspace pgtype.UUID, input ControllerRequest) (map[string]any, error) {
	tx, err := s.Transactions.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	current, err := q.LockEngineeringNativeTask(ctx, task.ID)
	if err != nil {
		return nil, err
	}
	if current.RuntimeID != task.RuntimeID || current.DispatchedAt.Valid != task.DispatchedAt.Valid || !current.DispatchedAt.Time.Equal(task.DispatchedAt.Time) {
		return nil, conflict("native claim changed during controller operation")
	}
	task = current
	if !input.ControllerID.Valid || input.HostID == "" || !task.RuntimeID.Valid || !task.DispatchedAt.Valid {
		return nil, conflict("controller requires the exact runtime claim and host")
	}
	var guard db.EngineeringRunGuard
	if input.Operation == "begin" {
		if task.Status != "dispatched" && task.Status != "waiting_local_directory" && task.Status != "running" {
			return nil, conflict("inactive native claim cannot acquire controller admission")
		}
		if input.PID <= 0 || input.Marker == "" || strings.TrimSpace(input.Provider) == "" {
			return nil, conflict("controller requires its actual host process identity")
		}
		guard, err = q.CreateEngineeringRunGuard(ctx, db.CreateEngineeringRunGuardParams{ControllerID: input.ControllerID, TaskID: task.ID, WorkspaceID: workspace, RuntimeID: task.RuntimeID, ClaimAt: task.DispatchedAt, Provider: input.Provider, HostID: input.HostID, ControllerPid: input.PID, ControllerMarker: input.Marker})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}
	guard, err = q.LockEngineeringRunGuard(ctx, db.LockEngineeringRunGuardParams{ControllerID: input.ControllerID, WorkspaceID: workspace})
	if err != nil {
		return nil, err
	}
	if guard.TaskID != task.ID || guard.RuntimeID != task.RuntimeID || !guard.ClaimAt.Time.Equal(task.DispatchedAt.Time) || guard.HostID != input.HostID {
		return nil, conflict("controller belongs to another native claim or host")
	}
	result := map[string]any{}
	var admissionErr error
	switch input.Operation {
	case "begin":
		if guard.Phase != "preparing" && guard.Phase != "waiting" || guard.ControllerPid != input.PID || guard.ControllerMarker != input.Marker || guard.Provider != input.Provider {
			return nil, conflict("controller admission cannot be replayed with changed identity")
		}
		if guard.Phase == "waiting" {
			project, err := q.GetEngineeringTaskProject(ctx, db.GetEngineeringTaskProjectParams{TaskID: task.ID, WorkspaceID: workspace})
			if err != nil {
				return nil, err
			}
			if project.ID != guard.ProjectID {
				return nil, conflict("native project changed during controller admission")
			}
			if err = q.EngineeringRequireProjectAvailable(ctx, guard.ProjectID); err != nil {
				return nil, err
			}
			// A savepoint retains the actual waiting controller when another
			// project execution owns admission. It does not invent a launch.
			admission, err := tx.Begin(ctx)
			if err != nil {
				return nil, err
			}
			_, err = s.Queries.WithTx(admission).AdmitEngineeringRunGuard(ctx, db.AdmitEngineeringRunGuardParams{ControllerID: guard.ControllerID, WorkspaceID: workspace})
			if err != nil {
				if rollbackErr := admission.Rollback(ctx); rollbackErr != nil {
					return nil, rollbackErr
				}
				if !IsProjectBusy(err) {
					return nil, err
				}
				if err = tx.Commit(ctx); err != nil {
					return nil, err
				}
				return map[string]any{"admitted": false, "waiting_repository": true}, nil
			}
			if err = admission.Commit(ctx); err != nil {
				return nil, err
			}
		}
		result = map[string]any{"admitted": true}
	case "workspace":
		if task.Status != "dispatched" && task.Status != "waiting_local_directory" && task.Status != "running" {
			return nil, conflict("inactive task cannot prepare a workspace")
		}
		project, err := q.GetEngineeringTaskProject(ctx, db.GetEngineeringTaskProjectParams{TaskID: task.ID, WorkspaceID: workspace})
		if err != nil {
			return nil, err
		}
		if project.ID != guard.ProjectID {
			return nil, conflict("native project changed during preparation")
		}
		if err = q.EngineeringRequireProjectAvailable(ctx, guard.ProjectID); err != nil {
			return nil, err
		}
		if input.Mode != "in_place" && input.Mode != "worktree" || !filepath.IsAbs(input.WorkspacePath) {
			return nil, conflict("workspace requires its actual absolute directory and mode")
		}
		root, err := filepath.EvalSymlinks(input.WorkspacePath)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(root)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return nil, conflict("workspace is not a directory")
		}
		if guard.WorkspacePath.Valid && (guard.WorkspacePath.String != root || guard.ExecutionMode.String != input.Mode) {
			return nil, conflict("controller workspace cannot be replaced")
		}
		if _, err = q.SetEngineeringRunWorkspace(ctx, db.SetEngineeringRunWorkspaceParams{ControllerID: input.ControllerID, WorkspaceID: workspace, WorkspacePath: pgtype.Text{String: root, Valid: true}, ExecutionMode: pgtype.Text{String: input.Mode, Valid: true}}); err != nil {
			return nil, err
		}
		result = map[string]any{"bound": true}
	case "end":
		if input.NoProviderStarted == nil {
			return nil, conflict("controller cleanup requires an explicit provider fact")
		}
		if guard.NoProviderStarted.Valid && guard.NoProviderStarted.Bool != *input.NoProviderStarted {
			return nil, conflict("controller cleanup fact cannot be rewritten")
		}
		processes, err := q.ListEngineeringRunProcesses(ctx, db.ListEngineeringRunProcessesParams{ControllerID: input.ControllerID, WorkspaceID: workspace})
		if err != nil {
			return nil, err
		}
		_, actualStarted := controllerProcessFacts(processes)
		if *input.NoProviderStarted && actualStarted {
			return nil, conflict("no-spawn cleanup contradicts recorded physical identity")
		}
		cleanup := guard
		cleanup.NoProviderStarted = pgtype.Bool{Bool: *input.NoProviderStarted, Valid: true}
		quiesced := ControllerCleanupConfirmed(cleanup, processes)
		phase := "unconfirmed"
		if quiesced {
			phase = "quiesced"
		}
		if guard.Phase == "quiesced" {
			if !quiesced {
				return nil, conflict("closed controller cannot become active again")
			}
		} else if _, err = q.FinishEngineeringRunGuard(ctx, db.FinishEngineeringRunGuardParams{ControllerID: input.ControllerID, WorkspaceID: workspace, Phase: phase, NoProviderStarted: pgtype.Bool{Bool: *input.NoProviderStarted, Valid: true}}); err != nil {
			return nil, err
		}
		result = map[string]any{"recorded": true, "quiesced": quiesced}
	case "process-reserve", "process-bind", "process-exit":
		if guard.Provider != "codex" || !input.AllocationID.Valid {
			return nil, conflict("provider has no supported physical lifecycle")
		}
		if input.Operation == "process-reserve" {
			if guard.Phase != "executing" || task.Status != "running" {
				return nil, conflict("inactive controller cannot start a provider")
			}
			if err = q.EngineeringRequireProjectAvailable(ctx, guard.ProjectID); err != nil {
				return nil, err
			}
		}
		if input.Operation == "process-reserve" {
			process, err := q.CreateEngineeringRunProcess(ctx, db.CreateEngineeringRunProcessParams{AllocationID: input.AllocationID, ControllerID: input.ControllerID, WorkspaceID: workspace})
			if errors.Is(err, pgx.ErrNoRows) {
				process, err = q.GetEngineeringRunProcess(ctx, db.GetEngineeringRunProcessParams{AllocationID: input.AllocationID, ControllerID: input.ControllerID, WorkspaceID: workspace})
			}
			if err != nil {
				return nil, err
			}
			result = map[string]any{"reserved": true, "status": process.Phase}
		} else if input.Operation == "process-bind" {
			if input.PID <= 0 || input.GroupID != input.PID || input.Marker == "" {
				return nil, conflict("provider requires its actual group leader and birth marker")
			}
			_, err = q.BindEngineeringRunProcess(ctx, db.BindEngineeringRunProcessParams{AllocationID: input.AllocationID, ControllerID: input.ControllerID, WorkspaceID: workspace, Pid: pgtype.Int8{Int64: input.PID, Valid: true}, Marker: pgtype.Text{String: input.Marker, Valid: true}, GroupID: pgtype.Int8{Int64: input.GroupID, Valid: true}})
			if err != nil {
				return nil, err
			}
			// Persist the real PID even when cancellation or takeover won the
			// launch race. A rejected acknowledgement makes the SDK stop it.
			if _, err = q.LockEngineeringProjectAdmission(ctx, db.LockEngineeringProjectAdmissionParams{ProjectID: guard.ProjectID, WorkspaceID: workspace}); err != nil {
				return nil, err
			}
			_, fenceErr := q.GetEngineeringRepairFence(ctx, db.GetEngineeringRepairFenceParams{ProjectID: guard.ProjectID, WorkspaceID: workspace})
			if fenceErr != nil && !errors.Is(fenceErr, pgx.ErrNoRows) {
				return nil, fenceErr
			}
			if fenceErr == nil || guard.Phase != "executing" || task.Status != "running" {
				admissionErr = conflict("provider identity recorded after execution admission closed")
			}
			result = map[string]any{"bound": true}
		} else {
			if input.Confirmed == nil || input.PID < 0 {
				return nil, conflict("provider cleanup requires its physical exit fact")
			}
			if !*input.Confirmed {
				if _, err = q.GetEngineeringRunProcess(ctx, db.GetEngineeringRunProcessParams{AllocationID: input.AllocationID, ControllerID: input.ControllerID, WorkspaceID: workspace}); err != nil {
					return nil, err
				}
				result = map[string]any{"exited": false}
			} else {
				if _, err = q.FinishEngineeringRunProcess(ctx, db.FinishEngineeringRunProcessParams{AllocationID: input.AllocationID, ControllerID: input.ControllerID, WorkspaceID: workspace, Pid: pgtype.Int8{Int64: input.PID, Valid: true}}); err != nil {
					return nil, err
				}
				result = map[string]any{"exited": true}
			}
		}
	default:
		return nil, conflict("unknown controller operation")
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, admissionErr
}
