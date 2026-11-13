-- name: HasUnfinishedEngineeringIssueTask :one
SELECT EXISTS (
    SELECT 1 FROM agent_task_queue
    WHERE issue_id = $1 AND status NOT IN ('completed', 'failed', 'cancelled')
) AS has_unfinished;
