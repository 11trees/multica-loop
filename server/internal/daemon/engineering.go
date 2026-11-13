package daemon

import (
	"context"
	"errors"
	"fmt"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

func (d *Daemon) bindEngineeringEnvironment(ctx context.Context, task Task, env *execenv.Environment, provider string) error {
	if task.EngineeringChain == "" {
		return nil
	}
	mode := "in_place"
	if env.LocalWorktree != nil {
		mode = "worktree"
	} else if !env.LocalDirectory {
		return errors.New("engineering requires a native local repository environment")
	}
	overlays, err := execenv.EngineeringOverlays(env, provider)
	if err != nil {
		return fmt.Errorf("engineering runtime context: %w", err)
	}
	if err := d.client.BindEngineeringRepository(ctx, task, env.WorkDir, mode, overlays); err != nil {
		return fmt.Errorf("engineering repository binding: %w", err)
	}
	return nil
}
