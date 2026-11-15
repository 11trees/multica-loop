ALTER TABLE engineering_run_guard ADD COLUMN scope_kind TEXT, ADD COLUMN scope_id UUID;
UPDATE engineering_run_guard g SET
    scope_kind=CASE WHEN t.issue_id IS NOT NULL THEN 'issue' ELSE 'chat' END,
    scope_id=COALESCE(t.issue_id,t.chat_session_id)
FROM agent_task_queue t WHERE t.id=g.task_id;
