ALTER TABLE engineering_run_guard ADD COLUMN project_serialized BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN claim_settled BOOLEAN NOT NULL DEFAULT false;
UPDATE engineering_run_guard g SET claim_settled=true WHERE NOT EXISTS (
    SELECT 1 FROM agent_task_queue t WHERE t.id=g.task_id AND t.runtime_id=g.runtime_id AND t.dispatched_at=g.claim_at
    AND t.status IN ('queued','dispatched','waiting_local_directory','running')
);
UPDATE engineering_run_guard SET project_serialized=true WHERE phase<>'quiesced' OR NOT claim_settled;

CREATE FUNCTION engineering_settle_controller_claim() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    UPDATE engineering_run_guard SET claim_settled=true
    WHERE task_id=NEW.id AND NOT claim_settled AND (
        NEW.status NOT IN ('queued','dispatched','waiting_local_directory','running')
        OR runtime_id IS DISTINCT FROM NEW.runtime_id OR claim_at IS DISTINCT FROM NEW.dispatched_at
    );
    RETURN NEW;
END;
$$;
CREATE TRIGGER engineering_controller_claim_settlement AFTER UPDATE OF status,runtime_id,dispatched_at ON agent_task_queue
FOR EACH ROW EXECUTE FUNCTION engineering_settle_controller_claim();
