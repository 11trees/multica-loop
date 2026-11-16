CREATE TABLE engineering_history_cutover (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    source_namespace TEXT NOT NULL,
    archive_hash TEXT NOT NULL,
    scope_hash TEXT NOT NULL,
    project_ids UUID[] NOT NULL CHECK (cardinality(project_ids)>0),
    phase TEXT NOT NULL DEFAULT 'held' CHECK (phase IN ('held','source_frozen','rollback_pending','cancelled')),
    prepared_by UUID NOT NULL,
    payload JSONB NOT NULL,
    receipt JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION engineering_history_project_held(target UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS(SELECT 1 FROM engineering_history_cutover WHERE target=ANY(project_ids) AND phase<>'cancelled');
$$;

CREATE OR REPLACE FUNCTION engineering_require_project_available(target UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF target IS NULL THEN RETURN; END IF;
    PERFORM id FROM project WHERE id=target FOR KEY SHARE;
    IF EXISTS(SELECT 1 FROM engineering_repair_fence WHERE project_id=target)
        OR EXISTS(SELECT 1 FROM engineering_repair_handoff WHERE project_id=target AND phase='reserved') THEN
        RAISE EXCEPTION 'engineering repair owns this project' USING ERRCODE='55000';
    END IF;
    IF engineering_history_project_held(target) THEN
        RAISE EXCEPTION 'LoopWork cutover holds this project' USING ERRCODE='55000';
    END IF;
END;
$$;

-- Every operator-side cohort insertion takes the same project admission locks
-- as native claims, before inspecting native state or changing source files.
CREATE FUNCTION engineering_guard_history_cutover() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
    IF TG_OP='UPDATE' THEN
        IF (NEW.id,NEW.workspace_id,NEW.source_namespace,NEW.archive_hash,NEW.scope_hash,NEW.project_ids,NEW.prepared_by,NEW.payload)
            IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.source_namespace,OLD.archive_hash,OLD.scope_hash,OLD.project_ids,OLD.prepared_by,OLD.payload) THEN
            RAISE EXCEPTION 'cutover scope is immutable' USING ERRCODE='55000';
        END IF;
        IF NEW.phase=OLD.phase THEN RETURN NEW; END IF;
        IF NOT ((OLD.phase='held' AND NEW.phase IN ('source_frozen','rollback_pending'))
            OR (OLD.phase='source_frozen' AND NEW.phase='rollback_pending')
            OR (OLD.phase='rollback_pending' AND NEW.phase='cancelled')) THEN
            RAISE EXCEPTION 'invalid cutover transition' USING ERRCODE='55000';
        END IF;
    ELSIF NEW.phase<>'held' THEN
        RAISE EXCEPTION 'cutover must begin held' USING ERRCODE='55000';
    END IF;
    FOR target IN SELECT DISTINCT unnest(NEW.project_ids) ORDER BY 1 LOOP
        PERFORM id FROM project WHERE id=target AND workspace_id=NEW.workspace_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'cutover project is unavailable' USING ERRCODE='55000'; END IF;
        IF TG_OP='INSERT' THEN PERFORM engineering_require_project_available(target); END IF;
        IF EXISTS(SELECT 1 FROM engineering_run_guard WHERE project_id=target AND (phase<>'quiesced' OR NOT claim_settled))
            OR EXISTS(SELECT 1 FROM agent_task_queue t LEFT JOIN issue i ON i.id=t.issue_id LEFT JOIN chat_session c ON c.id=t.chat_session_id
                WHERE COALESCE(i.project_id,c.project_id)=target AND t.status IN ('dispatched','waiting_local_directory','running')) THEN
            RAISE EXCEPTION 'cutover project has unsettled execution' USING ERRCODE='55000';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;
CREATE TRIGGER engineering_history_cutover_scope BEFORE INSERT OR UPDATE ON engineering_history_cutover
FOR EACH ROW EXECUTE FUNCTION engineering_guard_history_cutover();
