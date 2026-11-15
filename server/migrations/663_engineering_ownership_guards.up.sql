-- The project row serializes admission with fence acquisition. The volatile
-- function reads the fence after obtaining that lock, including after a wait.
CREATE FUNCTION engineering_require_project_available(target UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF target IS NULL THEN RETURN; END IF;
    PERFORM id FROM project WHERE id=target FOR KEY SHARE;
    IF EXISTS(SELECT 1 FROM engineering_repair_fence WHERE project_id=target) THEN
        RAISE EXCEPTION 'engineering repair owns this project' USING ERRCODE='55000';
    END IF;
END;
$$;
CREATE FUNCTION engineering_guard_task_admission() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
CREATE TRIGGER engineering_task_admission BEFORE INSERT OR UPDATE ON agent_task_queue
FOR EACH ROW EXECUTE FUNCTION engineering_guard_task_admission();
CREATE FUNCTION engineering_guard_controller_admission() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM engineering_require_project_available(NEW.project_id);
    RETURN NEW;
END;
$$;
CREATE TRIGGER engineering_controller_admission BEFORE INSERT ON engineering_run_guard
FOR EACH ROW EXECUTE FUNCTION engineering_guard_controller_admission();
CREATE FUNCTION engineering_guard_project_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
    IF TG_TABLE_NAME='project' THEN
        PERFORM engineering_require_project_available(OLD.id);
    ELSIF TG_TABLE_NAME='issue' THEN
        IF TG_OP='UPDATE' AND OLD.project_id IS DISTINCT FROM NEW.project_id THEN
            FOR target IN SELECT DISTINCT value FROM unnest(ARRAY[OLD.project_id,NEW.project_id]) AS value ORDER BY value LOOP
                PERFORM engineering_require_project_available(target);
            END LOOP;
        END IF;
    ELSE
        IF TG_OP<>'INSERT' THEN PERFORM engineering_require_project_available(OLD.project_id); END IF;
        IF TG_OP<>'DELETE' THEN PERFORM engineering_require_project_available(NEW.project_id); END IF;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER engineering_project_mutation BEFORE UPDATE OR DELETE ON project
FOR EACH ROW EXECUTE FUNCTION engineering_guard_project_mutation();
CREATE TRIGGER engineering_issue_project_mutation BEFORE UPDATE OF project_id ON issue
FOR EACH ROW EXECUTE FUNCTION engineering_guard_project_mutation();
CREATE TRIGGER engineering_resource_mutation BEFORE INSERT OR UPDATE OR DELETE ON project_resource
FOR EACH ROW EXECUTE FUNCTION engineering_guard_project_mutation();
