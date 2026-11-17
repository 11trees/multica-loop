-- name: LockEngineeringHistoryPreparation :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg('scope')::text, 0));

-- name: EngineeringHistoryProjectHeld :one
SELECT engineering_history_project_held($1::uuid)::boolean AS held;

-- name: EngineeringHistoryIssueHeld :one
SELECT engineering_history_issue_held($1::uuid)::boolean AS held;

-- name: LockEngineeringHistoryCutover :one
SELECT * FROM engineering_history_cutover WHERE id=$1 AND workspace_id=$2 FOR UPDATE;

-- name: GetEngineeringHistoryPreparationByID :one
SELECT * FROM engineering_history_preparation WHERE id=$1 AND workspace_id=$2;

-- name: ListEngineeringHistoryAdoptions :many
SELECT * FROM engineering_history_adoption WHERE cutover_id=$1 AND workspace_id=$2 ORDER BY source_task_id;

-- name: ListEngineeringHistoryTaskAdoptions :many
SELECT a.*,i.number AS issue_number,i.status AS issue_status FROM engineering_history_adoption a
LEFT JOIN issue i ON i.id=a.issue_id AND i.workspace_id=a.workspace_id
WHERE a.workspace_id=$1 AND a.source_namespace=$2 AND a.source_task_id=$3 ORDER BY a.created_at DESC;

-- name: CreateEngineeringHistoryAdoption :one
INSERT INTO engineering_history_adoption(cutover_id,workspace_id,source_namespace,source_task_id,preparation_id,issue_id,payload)
VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *;

-- name: WithdrawEngineeringHistoryAdoption :one
UPDATE engineering_history_adoption SET phase='withdrawn',withdrawn_at=now()
WHERE cutover_id=$1 AND workspace_id=$2 AND source_task_id=$3 AND phase='staged' RETURNING *;

-- name: LockEngineeringHistoryIssueSnapshot :one
SELECT ((to_jsonb(i)-'created_at'-'updated_at'-'last_activity_at') || jsonb_build_object(
    'created_at_epoch',extract(epoch FROM i.created_at),'updated_at_epoch',extract(epoch FROM i.updated_at),
    'last_activity_at_epoch',extract(epoch FROM i.last_activity_at)))::jsonb AS snapshot
FROM issue i WHERE id=$1 AND workspace_id=$2 FOR UPDATE;

-- name: CancelEngineeringHistoryDraft :one
UPDATE issue SET status='cancelled',revision=revision+1,updated_at=now(),last_activity_at=now()
WHERE id=$1 AND workspace_id=$2 AND status='backlog' RETURNING *;

-- name: DeactivateEngineeringHistoryCutover :one
UPDATE engineering_history_cutover SET phase='deactivated',deactivation=$3,updated_at=now()
WHERE id=$1 AND workspace_id=$2 AND phase='activated' AND deactivation IS NULL RETURNING *;

-- name: DeactivateEngineeringHistoryAdoption :one
UPDATE engineering_history_adoption SET phase='withdrawn',withdrawn_at=now()
WHERE cutover_id=$1 AND workspace_id=$2 AND source_task_id=$3 AND phase='activated' RETURNING *;

-- name: DeleteEngineeringHistoryActivationResource :one
DELETE FROM project_resource WHERE id=$1 AND workspace_id=$2 AND project_id=$3
AND resource_type='local_directory' AND resource_ref=$4 AND created_by=$5 AND position=0 AND label IS NULL
RETURNING id;

-- name: HasEngineeringHistoryExecution :one
SELECT EXISTS(SELECT 1 FROM chat_session WHERE project_id=ANY(@project_ids::uuid[]))
 OR EXISTS(SELECT 1 FROM engineering_run_guard WHERE project_id=ANY(@project_ids::uuid[]))
 OR EXISTS(SELECT 1 FROM engineering_repair_fence WHERE project_id=ANY(@project_ids::uuid[]))
 OR EXISTS(SELECT 1 FROM engineering_repair_handoff WHERE project_id=ANY(@project_ids::uuid[]))
 OR EXISTS(SELECT 1 FROM agent_task_queue t JOIN issue i ON i.id=t.issue_id WHERE i.project_id=ANY(@project_ids::uuid[])) AS active;

-- name: ListEngineeringHistoryProjectIssues :many
SELECT i.* FROM issue i WHERE i.workspace_id=$1 AND i.project_id=ANY($2::uuid[])
AND NOT EXISTS(SELECT 1 FROM engineering_history_adoption a WHERE a.issue_id=i.id AND a.phase='withdrawn' AND i.status='cancelled') ORDER BY i.id;

-- name: LockEngineeringHistoryAdoptionProject :one
SELECT * FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE;

-- name: HasEngineeringHistoryProjectActivity :one
SELECT EXISTS(SELECT 1 FROM chat_session WHERE project_id=ANY(@project_ids::uuid[]))
 OR EXISTS(SELECT 1 FROM project_resource WHERE project_id=ANY(@project_ids::uuid[]))
 OR EXISTS(SELECT 1 FROM engineering_run_guard WHERE project_id=ANY(@project_ids::uuid[]))
 OR EXISTS(SELECT 1 FROM engineering_repair_fence WHERE project_id=ANY(@project_ids::uuid[]))
 OR EXISTS(SELECT 1 FROM engineering_repair_handoff WHERE project_id=ANY(@project_ids::uuid[]))
 OR EXISTS(SELECT 1 FROM agent_task_queue t JOIN issue i ON i.id=t.issue_id WHERE i.project_id=ANY(@project_ids::uuid[])) AS active;

-- name: LockEngineeringHistoryTargetProject :one
SELECT * FROM project WHERE id = $1 AND workspace_id = $2 FOR SHARE;

-- name: GetEngineeringHistoryProject :one
SELECT * FROM engineering_history_project
WHERE workspace_id = $1 AND source_namespace = $2 AND source_project_id = $3;

-- name: CreateEngineeringHistoryProject :one
INSERT INTO engineering_history_project (workspace_id, source_namespace, source_project_id, project_id, created_by)
VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: ListEngineeringHistoryPreparations :many
SELECT * FROM engineering_history_preparation
WHERE workspace_id = $1 AND source_namespace = $2 AND source_task_id = $3
ORDER BY revision DESC;

-- name: CreateEngineeringHistoryPreparation :one
INSERT INTO engineering_history_preparation (
    workspace_id, source_namespace, source_project_id, source_task_id, revision,
    archive_hash, packet_hash, project_id, team_id, team_revision, prepared_by, payload
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *;

-- name: ActivateEngineeringHistoryCutover :one
UPDATE engineering_history_cutover SET phase='activated',activation=$3,updated_at=now()
WHERE id=$1 AND workspace_id=$2 AND phase='source_frozen' RETURNING *;

-- name: ActivateEngineeringHistoryAdoption :one
UPDATE engineering_history_adoption SET phase='activated'
WHERE cutover_id=$1 AND workspace_id=$2 AND source_task_id=$3 AND phase='staged' RETURNING *;

-- name: LockEngineeringHistoryRuntime :one
SELECT * FROM agent_runtime WHERE id=$1 AND workspace_id=$2 FOR SHARE;

-- name: GetActivatedEngineeringHistoryPreparation :one
SELECT p.* FROM engineering_history_adoption a JOIN engineering_history_preparation p ON p.id=a.preparation_id
WHERE a.issue_id=$1 AND a.workspace_id=$2 AND a.phase='activated';

-- name: CreateEngineeringHistoryResource :exec
INSERT INTO project_resource(id,project_id,workspace_id,resource_type,resource_ref,position,created_by)
VALUES($1,$2,$3,'local_directory',$4,0,$5);

-- name: ActivateEngineeringHistoryDraftNotice :one
UPDATE issue SET description=$3,revision=revision+1,updated_at=now(),last_activity_at=now()
WHERE id=$1 AND workspace_id=$2 AND status='backlog' RETURNING *;
