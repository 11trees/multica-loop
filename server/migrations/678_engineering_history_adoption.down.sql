DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM engineering_history_adoption) THEN
        RAISE EXCEPTION 'retain migration correspondence and execution barriers' USING ERRCODE='55000';
    END IF;
END $$;
DROP TRIGGER IF EXISTS engineering_history_adoption_scope ON engineering_history_adoption;
DROP FUNCTION IF EXISTS engineering_guard_history_adoption();
DROP TRIGGER IF EXISTS engineering_history_issue_status ON issue;
DROP FUNCTION IF EXISTS engineering_guard_history_issue_status();
DROP TRIGGER IF EXISTS engineering_history_issue_run ON agent_task_queue;
DROP FUNCTION IF EXISTS engineering_guard_history_issue_run();
DROP FUNCTION IF EXISTS engineering_history_issue_held(UUID);
DROP TABLE IF EXISTS engineering_history_adoption;
