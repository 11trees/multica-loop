CREATE TABLE engineering_repair_fence (
    workspace_id UUID NOT NULL,
    project_id UUID NOT NULL,
    case_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    generation BIGINT NOT NULL,
    owner_id TEXT NOT NULL,
    supervision_token BIGINT NOT NULL,
    intent_revision BIGINT NOT NULL,
    observation_id TEXT NOT NULL,
    issue_id UUID NOT NULL,
    source_attempt_id TEXT NOT NULL,
    source_revision BIGINT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'draining',
    targets JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE engineering_run_guard (
    controller_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    runtime_id UUID NOT NULL,
    claim_at TIMESTAMPTZ NOT NULL,
    provider TEXT NOT NULL,
    host_id TEXT NOT NULL,
    controller_pid BIGINT NOT NULL,
    controller_marker TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'preparing',
    workspace_path TEXT,
    execution_mode TEXT,
    no_provider_started BOOLEAN,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE engineering_run_process (
    allocation_id UUID NOT NULL,
    controller_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    phase TEXT NOT NULL DEFAULT 'launching',
    pid BIGINT,
    marker TEXT,
    group_id BIGINT,
    exit_pid BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
