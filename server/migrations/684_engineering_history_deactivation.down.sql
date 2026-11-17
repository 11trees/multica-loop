DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM engineering_history_cutover WHERE deactivation IS NOT NULL OR phase='deactivated') THEN
        RAISE EXCEPTION 'retain deactivated ownership and its immutable receipts' USING ERRCODE='55000';
    END IF;
END $$;
CREATE OR REPLACE FUNCTION engineering_guard_history_cutover() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
    IF TG_OP='UPDATE' THEN
        IF (NEW.id,NEW.workspace_id,NEW.source_namespace,NEW.archive_hash,NEW.scope_hash,NEW.project_ids,NEW.prepared_by,NEW.payload)
            IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.source_namespace,OLD.archive_hash,OLD.scope_hash,OLD.project_ids,OLD.prepared_by,OLD.payload) THEN
            RAISE EXCEPTION 'cutover scope is immutable' USING ERRCODE='55000';
        END IF;
        IF OLD.activation IS NOT NULL AND NEW.activation IS DISTINCT FROM OLD.activation THEN
            RAISE EXCEPTION 'activation receipt is immutable' USING ERRCODE='55000';
        END IF;
        IF NEW.phase=OLD.phase THEN
            IF NEW.activation IS DISTINCT FROM OLD.activation THEN RAISE EXCEPTION 'activation requires ownership transition' USING ERRCODE='55000'; END IF;
            RETURN NEW;
        END IF;
        IF NOT ((OLD.phase='held' AND NEW.phase IN ('source_frozen','rollback_pending'))
            OR (OLD.phase='source_frozen' AND NEW.phase IN ('rollback_pending','activated'))
            OR (OLD.phase='rollback_pending' AND NEW.phase='cancelled')) THEN
            RAISE EXCEPTION 'invalid cutover transition' USING ERRCODE='55000';
        END IF;
    ELSIF NEW.phase<>'held' THEN
        RAISE EXCEPTION 'cutover must begin held' USING ERRCODE='55000';
    END IF;
    IF NEW.phase='activated' THEN
        IF NEW.activation IS NULL OR NEW.activation->>'format' IS DISTINCT FROM 'loopwork-native-activation-v1'
            OR NEW.activation->>'cutover_id' IS DISTINCT FROM NEW.id::text
            OR NEW.activation->>'scope_hash' IS DISTINCT FROM NEW.scope_hash
            OR NEW.activation->>'activated_by' IS DISTINCT FROM NEW.prepared_by::text
            OR NOT COALESCE(NEW.activation->>'workspace_hash' ~ '^[a-f0-9]{64}$',false)
            OR jsonb_typeof(NEW.activation->'tasks') IS DISTINCT FROM 'array'
            OR jsonb_array_length(NEW.activation->'tasks')<>jsonb_array_length(NEW.payload->'preparations') THEN
            RAISE EXCEPTION 'activation receipt is unavailable' USING ERRCODE='55000';
        END IF;
    ELSIF NEW.activation IS NOT NULL THEN
        RAISE EXCEPTION 'inactive cutover cannot own an activation' USING ERRCODE='55000';
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
CREATE OR REPLACE FUNCTION engineering_guard_history_adoption() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF (NEW.cutover_id,NEW.workspace_id,NEW.source_namespace,NEW.source_task_id,NEW.preparation_id,NEW.issue_id,NEW.payload,NEW.created_at)
            IS DISTINCT FROM (OLD.cutover_id,OLD.workspace_id,OLD.source_namespace,OLD.source_task_id,OLD.preparation_id,OLD.issue_id,OLD.payload,OLD.created_at)
            OR NOT (OLD.phase='staged' AND (
                NEW.phase='withdrawn' AND NEW.withdrawn_at IS NOT NULL
                OR NEW.phase='activated' AND NEW.withdrawn_at IS NULL AND EXISTS(
                    SELECT 1 FROM engineering_history_cutover c WHERE c.id=NEW.cutover_id AND c.workspace_id=NEW.workspace_id
                    AND c.phase='activated' AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.activation->'tasks') t
                        WHERE t->>'issue_id'=NEW.issue_id::text AND t->>'preparation_id'=NEW.preparation_id::text
                        AND t->>'source_task_id'=NEW.source_task_id)))) THEN
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
ALTER TABLE engineering_history_cutover DROP CONSTRAINT engineering_history_cutover_phase_check;
ALTER TABLE engineering_history_cutover ADD CONSTRAINT engineering_history_cutover_phase_check CHECK(phase IN ('held','source_frozen','rollback_pending','cancelled','activated'));
ALTER TABLE engineering_history_cutover DROP COLUMN deactivation;
