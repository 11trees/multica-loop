-- name: LockEngineeringNativeTask :one
SELECT * FROM agent_task_queue WHERE id = @task_id FOR UPDATE;

-- name: LockEngineeringProjectAdmission :one
SELECT * FROM project WHERE id = @project_id AND workspace_id = @workspace_id FOR KEY SHARE;

-- name: GetEngineeringTaskProject :one
SELECT p.* FROM agent_task_queue t
LEFT JOIN issue i ON i.id=t.issue_id
LEFT JOIN chat_session c ON c.id=t.chat_session_id
JOIN project p ON p.id=COALESCE(i.project_id,c.project_id)
WHERE t.id = @task_id AND p.workspace_id = @workspace_id;

-- name: CreateEngineeringRunGuard :one
INSERT INTO engineering_run_guard(controller_id,workspace_id,project_id,task_id,runtime_id,claim_at,provider,host_id,controller_pid,controller_marker,scope_kind,scope_id)
SELECT @controller_id,p.workspace_id,p.id,t.id,t.runtime_id,t.dispatched_at,@provider,@host_id,@controller_pid,@controller_marker,CASE WHEN t.issue_id IS NOT NULL THEN 'issue' ELSE 'chat' END,COALESCE(t.issue_id,t.chat_session_id)
FROM agent_task_queue t
LEFT JOIN issue i ON i.id=t.issue_id
LEFT JOIN chat_session c ON c.id=t.chat_session_id
JOIN project p ON p.id=COALESCE(i.project_id,c.project_id)
WHERE t.id = @task_id AND p.workspace_id = @workspace_id AND t.runtime_id = @runtime_id
 AND t.dispatched_at = @claim_at AND t.status IN ('dispatched','waiting_local_directory','running')
ON CONFLICT(controller_id) DO NOTHING
RETURNING *;

-- name: GetEngineeringRunGuard :one
SELECT * FROM engineering_run_guard WHERE controller_id = @controller_id AND workspace_id = @workspace_id;

-- name: LockEngineeringRunGuard :one
SELECT * FROM engineering_run_guard WHERE controller_id = @controller_id AND workspace_id = @workspace_id FOR UPDATE;

-- name: SetEngineeringRunWorkspace :one
UPDATE engineering_run_guard SET workspace_path = @workspace_path,execution_mode = @execution_mode,phase='executing',updated_at=now()
WHERE controller_id = @controller_id AND workspace_id = @workspace_id AND phase IN ('preparing','executing') RETURNING *;

-- name: FinishEngineeringRunGuard :one
UPDATE engineering_run_guard SET phase = @phase,no_provider_started = @no_provider_started,updated_at=now()
WHERE controller_id = @controller_id AND workspace_id = @workspace_id AND phase<>'quiesced' RETURNING *;

-- name: ListEngineeringRunProcesses :many
SELECT * FROM engineering_run_process WHERE controller_id = @controller_id AND workspace_id = @workspace_id ORDER BY created_at,allocation_id;

-- name: CreateEngineeringRunProcess :one
INSERT INTO engineering_run_process(allocation_id,controller_id,workspace_id)
VALUES(@allocation_id,@controller_id,@workspace_id)
ON CONFLICT(allocation_id) DO NOTHING RETURNING *;

-- name: GetEngineeringRunProcess :one
SELECT * FROM engineering_run_process WHERE allocation_id = @allocation_id AND controller_id = @controller_id AND workspace_id = @workspace_id;

-- name: BindEngineeringRunProcess :one
UPDATE engineering_run_process SET phase='running',pid = @pid,marker = @marker,group_id = @group_id,updated_at=now()
WHERE allocation_id = @allocation_id AND controller_id = @controller_id AND workspace_id = @workspace_id
 AND phase IN ('launching','running') AND (pid IS NULL OR (pid = @pid AND marker = @marker AND group_id = @group_id)) RETURNING *;

-- name: FinishEngineeringRunProcess :one
UPDATE engineering_run_process SET phase='exited',exit_pid = @pid,updated_at=now()
WHERE allocation_id = @allocation_id AND controller_id = @controller_id AND workspace_id = @workspace_id
 AND (pid IS NULL OR pid = @pid) AND (exit_pid IS NULL OR exit_pid = @pid) RETURNING *;

-- name: EngineeringRequireProjectAvailable :exec
SELECT engineering_require_project_available(@project_id::uuid);

-- name: LockEngineeringProject :one
SELECT * FROM project WHERE id = @project_id AND workspace_id = @workspace_id FOR UPDATE;

-- name: GetEngineeringRepairFence :one
SELECT * FROM engineering_repair_fence WHERE project_id = @project_id AND workspace_id = @workspace_id;

-- name: LockEngineeringRepairFence :one
SELECT * FROM engineering_repair_fence WHERE project_id = @project_id AND workspace_id = @workspace_id FOR UPDATE;

-- name: CreateEngineeringRepairFence :one
INSERT INTO engineering_repair_fence(workspace_id,project_id,case_id,attempt_id,generation,owner_id,supervision_token,intent_revision,observation_id,issue_id,source_attempt_id,source_revision,snapshot_hash,workspace_path)
VALUES(@workspace_id,@project_id,@case_id,@attempt_id,@generation,@owner_id,@supervision_token,@intent_revision,@observation_id,@issue_id,@source_attempt_id,@source_revision,@snapshot_hash,@workspace_path)
ON CONFLICT(workspace_id,project_id) DO NOTHING RETURNING *;

-- name: ReplaceEngineeringRepairFenceOwner :one
UPDATE engineering_repair_fence SET attempt_id = @attempt_id,generation = @generation,owner_id = @owner_id,supervision_token = @supervision_token,intent_revision = @intent_revision,phase='draining',updated_at=now()
WHERE workspace_id = @workspace_id AND project_id = @project_id AND case_id = @case_id AND generation < @generation RETURNING *;

-- name: SetEngineeringRepairFenceState :one
UPDATE engineering_repair_fence SET phase = @phase,targets = @targets,updated_at=now()
WHERE workspace_id = @workspace_id AND project_id = @project_id AND case_id = @case_id AND attempt_id = @attempt_id AND generation = @generation AND owner_id = @owner_id AND supervision_token = @supervision_token RETURNING *;

-- name: ListEngineeringProjectControllers :many
SELECT * FROM engineering_run_guard WHERE workspace_id = @workspace_id AND project_id = @project_id ORDER BY created_at,controller_id;

-- name: ListEngineeringProjectActiveTasks :many
SELECT t.* FROM agent_task_queue t LEFT JOIN issue i ON i.id=t.issue_id LEFT JOIN chat_session c ON c.id=t.chat_session_id
WHERE COALESCE(i.project_id,c.project_id) = @project_id AND COALESCE(i.workspace_id,c.workspace_id) = @workspace_id
 AND t.status IN ('queued','dispatched','waiting_local_directory','running') ORDER BY t.created_at,t.id;

-- name: ListEngineeringProjectWriterTasks :many
SELECT t.* FROM agent_task_queue t
LEFT JOIN issue i ON i.id=t.issue_id LEFT JOIN chat_session c ON c.id=t.chat_session_id
WHERE COALESCE(i.project_id,c.project_id) = @project_id AND COALESCE(i.workspace_id,c.workspace_id) = @workspace_id
 AND (t.dispatched_at IS NOT NULL OR t.started_at IS NOT NULL OR t.status IN ('queued','dispatched','waiting_local_directory','running'))
ORDER BY t.created_at,t.id;

-- name: ListEngineeringRepairHandoffReservations :many
SELECT * FROM engineering_repair_handoff
WHERE workspace_id = @workspace_id AND project_id = @project_id AND phase='reserved'
ORDER BY target_hash FOR UPDATE;

-- name: GetEngineeringRepairHandoff :one
SELECT * FROM engineering_repair_handoff WHERE target_hash = @target_hash;

-- name: CreateEngineeringRepairHandoffReservation :one
INSERT INTO engineering_repair_handoff(target_hash,workspace_id,project_id,task_id,payload)
VALUES(@target_hash,@workspace_id,@project_id,@task_id,@payload)
ON CONFLICT(target_hash) DO NOTHING RETURNING *;
