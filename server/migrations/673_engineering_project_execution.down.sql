DROP TRIGGER IF EXISTS engineering_controller_claim_settlement ON agent_task_queue;
DROP FUNCTION IF EXISTS engineering_settle_controller_claim();
ALTER TABLE engineering_run_guard DROP COLUMN IF EXISTS project_serialized, DROP COLUMN IF EXISTS claim_settled;
