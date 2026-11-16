DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM engineering_history_cutover WHERE phase<>'cancelled') THEN
        RAISE EXCEPTION 'finish cutover rollback before removing its native barrier' USING ERRCODE='55000';
    END IF;
END $$;
DROP TRIGGER IF EXISTS engineering_history_cutover_scope ON engineering_history_cutover;
DROP FUNCTION IF EXISTS engineering_guard_history_cutover();
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
DROP FUNCTION IF EXISTS engineering_history_project_held(UUID);
DROP TABLE IF EXISTS engineering_history_cutover;
