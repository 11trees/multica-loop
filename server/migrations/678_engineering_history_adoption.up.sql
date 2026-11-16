CREATE TABLE engineering_history_adoption (
    cutover_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    source_namespace TEXT NOT NULL,
    source_task_id TEXT NOT NULL,
    preparation_id UUID NOT NULL,
    issue_id UUID NOT NULL,
    phase TEXT NOT NULL DEFAULT 'staged' CHECK (phase IN ('staged','withdrawn')),
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    withdrawn_at TIMESTAMPTZ
);

CREATE FUNCTION engineering_history_issue_held(target UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS(SELECT 1 FROM engineering_history_adoption WHERE issue_id=target);
$$;
CREATE FUNCTION engineering_guard_history_issue_run() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IN ('queued','dispatched','waiting_local_directory','running') AND engineering_history_issue_held(NEW.issue_id) THEN
        RAISE EXCEPTION 'migration task is not activated' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER engineering_history_issue_run BEFORE INSERT OR UPDATE ON agent_task_queue
FOR EACH ROW EXECUTE FUNCTION engineering_guard_history_issue_run();

CREATE FUNCTION engineering_guard_history_issue_status() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE adoption_phase TEXT;
BEGIN
    SELECT phase INTO adoption_phase FROM engineering_history_adoption WHERE issue_id=NEW.id;
    IF adoption_phase='staged' AND NEW.status NOT IN ('backlog','cancelled')
        OR adoption_phase='withdrawn' AND NEW.status<>'cancelled' THEN
        RAISE EXCEPTION 'migration task requires explicit activation' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER engineering_history_issue_status BEFORE UPDATE OF status ON issue
FOR EACH ROW EXECUTE FUNCTION engineering_guard_history_issue_status();

CREATE FUNCTION engineering_guard_history_adoption() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF (NEW.cutover_id,NEW.workspace_id,NEW.source_namespace,NEW.source_task_id,NEW.preparation_id,NEW.issue_id,NEW.payload,NEW.created_at)
            IS DISTINCT FROM (OLD.cutover_id,OLD.workspace_id,OLD.source_namespace,OLD.source_task_id,OLD.preparation_id,OLD.issue_id,OLD.payload,OLD.created_at)
            OR NOT (OLD.phase='staged' AND NEW.phase='withdrawn' AND NEW.withdrawn_at IS NOT NULL) THEN
            RAISE EXCEPTION 'migration correspondence is immutable' USING ERRCODE='55000';
        END IF;
    ELSE
        IF NEW.phase<>'staged' OR NOT EXISTS (
            SELECT 1 FROM engineering_history_cutover c JOIN engineering_history_preparation p ON p.id=NEW.preparation_id
            JOIN issue i ON i.id=NEW.issue_id
            WHERE c.id=NEW.cutover_id AND c.workspace_id=NEW.workspace_id AND c.phase='source_frozen'
            AND c.source_namespace=NEW.source_namespace AND p.workspace_id=c.workspace_id
            AND p.source_namespace=c.source_namespace AND p.source_task_id=NEW.source_task_id AND p.archive_hash=c.archive_hash
            AND i.workspace_id=c.workspace_id AND i.project_id=p.project_id AND i.project_id=ANY(c.project_ids)
            AND i.assignee_type='squad' AND i.assignee_id=p.team_id AND i.creator_type='member' AND i.creator_id=c.prepared_by
            AND i.status='backlog'
            AND NOT EXISTS(SELECT 1 FROM agent_task_queue WHERE issue_id=i.id)
        ) THEN RAISE EXCEPTION 'migration task scope changed' USING ERRCODE='55000'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER engineering_history_adoption_scope BEFORE INSERT OR UPDATE ON engineering_history_adoption
FOR EACH ROW EXECUTE FUNCTION engineering_guard_history_adoption();
