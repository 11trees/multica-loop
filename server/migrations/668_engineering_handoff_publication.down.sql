CREATE OR REPLACE FUNCTION engineering_guard_task_admission() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
    IF NEW.status NOT IN ('dispatched','waiting_local_directory','running') THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND OLD.status=NEW.status
        AND OLD.dispatched_at IS NOT DISTINCT FROM NEW.dispatched_at
        AND OLD.runtime_id IS NOT DISTINCT FROM NEW.runtime_id
        AND OLD.issue_id IS NOT DISTINCT FROM NEW.issue_id
        AND OLD.chat_session_id IS NOT DISTINCT FROM NEW.chat_session_id THEN RETURN NEW; END IF;
    SELECT project_id INTO target FROM issue WHERE id=NEW.issue_id;
    IF target IS NULL THEN SELECT project_id INTO target FROM chat_session WHERE id=NEW.chat_session_id; END IF;
    PERFORM engineering_require_project_available(target);
    RETURN NEW;
END;
$$;
DROP TABLE engineering_repair_publication;
