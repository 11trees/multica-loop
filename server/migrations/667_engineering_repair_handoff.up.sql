CREATE TABLE engineering_repair_handoff (
    target_hash TEXT PRIMARY KEY,
    workspace_id UUID NOT NULL,
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    phase TEXT NOT NULL DEFAULT 'reserved' CHECK (phase IN ('reserved','published')),
    payload TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION engineering_require_project_available(target UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF target IS NULL THEN RETURN; END IF;
    PERFORM id FROM project WHERE id=target FOR KEY SHARE;
    IF EXISTS(SELECT 1 FROM engineering_repair_fence WHERE project_id=target)
        OR EXISTS(SELECT 1 FROM engineering_repair_handoff WHERE project_id=target AND phase='reserved') THEN
        RAISE EXCEPTION 'engineering repair owns this project' USING ERRCODE='55000';
    END IF;
END;
$$;
