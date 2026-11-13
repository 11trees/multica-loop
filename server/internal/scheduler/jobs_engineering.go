package scheduler

import (
	"context"
	"time"
)

type EngineeringCoordinator interface{ ReconcileEngineering(context.Context) error }

func EngineeringContinuationJob(coordinator EngineeringCoordinator) JobSpec {
	return JobSpec{
		Name: "engineering_continuation_dispatch", Cadence: 30 * time.Second, CatchUpMode: CatchUpLatestOnly, CatchUpWindow: time.Hour,
		RunTimeout: 45 * time.Second, StaleTimeout: time.Minute, HeartbeatInterval: 10 * time.Second,
		AllowStaleReentry: true, MaxAttempts: 1, Scopes: StaticScopes(ScopeGlobal),
		Handler: func(ctx context.Context, _ HandlerInput) (HandlerResult, error) {
			return HandlerResult{}, coordinator.ReconcileEngineering(ctx)
		},
	}
}
