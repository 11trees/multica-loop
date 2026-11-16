CREATE TABLE engineering_history_project (
    workspace_id UUID NOT NULL,
    source_namespace TEXT NOT NULL,
    source_project_id TEXT NOT NULL,
    project_id UUID NOT NULL,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE engineering_history_preparation (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    source_namespace TEXT NOT NULL,
    source_project_id TEXT NOT NULL,
    source_task_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    archive_hash TEXT NOT NULL,
    packet_hash TEXT NOT NULL,
    project_id UUID NOT NULL,
    team_id UUID NOT NULL,
    team_revision INTEGER NOT NULL CHECK (team_revision > 0),
    prepared_by UUID NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
