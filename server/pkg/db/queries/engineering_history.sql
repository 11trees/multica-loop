-- name: LockEngineeringHistoryPreparation :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg('scope')::text, 0));

-- name: EngineeringHistoryProjectHeld :one
SELECT engineering_history_project_held($1::uuid)::boolean AS held;

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
