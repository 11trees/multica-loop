CREATE TABLE engineering_repair_publication (
    target_hash TEXT PRIMARY KEY,
    workspace_id UUID NOT NULL,
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    payload TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION engineering_guard_task_admission() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
    IF NEW.status NOT IN ('queued','dispatched','waiting_local_directory','running') THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND OLD.status=NEW.status
        AND OLD.dispatched_at IS NOT DISTINCT FROM NEW.dispatched_at
        AND OLD.runtime_id IS NOT DISTINCT FROM NEW.runtime_id
        AND OLD.issue_id IS NOT DISTINCT FROM NEW.issue_id
        AND OLD.chat_session_id IS NOT DISTINCT FROM NEW.chat_session_id THEN RETURN NEW; END IF;
    SELECT project_id INTO target FROM issue WHERE id=NEW.issue_id;
    IF target IS NULL THEN SELECT project_id INTO target FROM chat_session WHERE id=NEW.chat_session_id; END IF;
    IF NEW.status='queued' THEN
        PERFORM id FROM project WHERE id=target FOR KEY SHARE;
        IF EXISTS(SELECT 1 FROM engineering_repair_handoff WHERE project_id=target AND phase='reserved') THEN
            RAISE EXCEPTION 'engineering handoff reserves this project' USING ERRCODE='55000';
        END IF;
    ELSE
        PERFORM engineering_require_project_available(target);
    END IF;
    RETURN NEW;
END;
$$;
