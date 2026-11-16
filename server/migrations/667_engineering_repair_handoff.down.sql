CREATE OR REPLACE FUNCTION engineering_require_project_available(target UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF target IS NULL THEN RETURN; END IF;
    PERFORM id FROM project WHERE id=target FOR KEY SHARE;
    IF EXISTS(SELECT 1 FROM engineering_repair_fence WHERE project_id=target) THEN
        RAISE EXCEPTION 'engineering repair owns this project' USING ERRCODE='55000';
    END IF;
END;
$$;
DROP TABLE engineering_repair_handoff;
