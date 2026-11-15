CREATE FUNCTION engineering_guard_chat_project_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
    IF OLD.project_id IS DISTINCT FROM NEW.project_id THEN
        FOR target IN SELECT DISTINCT value FROM unnest(ARRAY[OLD.project_id,NEW.project_id]) AS value ORDER BY value LOOP
            PERFORM engineering_require_project_available(target);
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER engineering_chat_project_mutation BEFORE UPDATE OF project_id ON chat_session
FOR EACH ROW EXECUTE FUNCTION engineering_guard_chat_project_mutation();
