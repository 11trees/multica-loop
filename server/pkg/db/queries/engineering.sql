-- name: HasUnfinishedEngineeringIssueTask :one
SELECT EXISTS (
    SELECT 1 FROM agent_task_queue t
    WHERE t.issue_id = $1 AND t.status NOT IN ('completed', 'failed', 'cancelled')
UNION ALL
    SELECT 1 FROM engineering_run_guard g
    WHERE g.scope_kind='issue' AND g.scope_id=$1 AND g.phase<>'quiesced'
) AS has_unfinished;
