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
INSERT INTO engineering_run_guard(controller_id,workspace_id,project_id,task_id,runtime_id,claim_at,provider,host_id,controller_pid,controller_marker,scope_kind,scope_id,phase)
SELECT @controller_id,p.workspace_id,p.id,t.id,t.runtime_id,t.dispatched_at,@provider,@host_id,@controller_pid,@controller_marker,CASE WHEN t.issue_id IS NOT NULL THEN 'issue' ELSE 'chat' END,COALESCE(t.issue_id,t.chat_session_id),'waiting'
FROM agent_task_queue t
LEFT JOIN issue i ON i.id=t.issue_id
LEFT JOIN chat_session c ON c.id=t.chat_session_id
JOIN project p ON p.id=COALESCE(i.project_id,c.project_id)
WHERE t.id = @task_id AND p.workspace_id = @workspace_id AND t.runtime_id = @runtime_id
 AND t.dispatched_at = @claim_at AND t.status IN ('dispatched','waiting_local_directory','running')
ON CONFLICT(controller_id) DO NOTHING
RETURNING *;

-- name: AdmitEngineeringRunGuard :one
UPDATE engineering_run_guard g SET phase='preparing',updated_at=now(),project_serialized=(
    SELECT NOT t.is_leader_task AND runtime.runtime_mode='local' FROM agent_task_queue t JOIN agent_runtime runtime ON runtime.id=t.runtime_id WHERE t.id=g.task_id
)
WHERE g.controller_id = @controller_id AND g.workspace_id = @workspace_id AND g.phase='waiting' RETURNING *;

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

-- name: GetEngineeringRepairPublication :one
SELECT * FROM engineering_repair_publication WHERE target_hash = @target_hash;

-- name: CreateEngineeringRepairPublication :one
INSERT INTO engineering_repair_publication(target_hash,workspace_id,project_id,task_id,payload)
VALUES(@target_hash,@workspace_id,@project_id,@task_id,@payload) RETURNING *;

-- name: PublishEngineeringRepairReservation :execrows
UPDATE engineering_repair_handoff SET phase='published'
WHERE target_hash = @target_hash AND workspace_id = @workspace_id AND project_id = @project_id AND phase='reserved' AND payload = @payload;

-- name: ReleasePublishedEngineeringRepairFence :execrows
DELETE FROM engineering_repair_fence WHERE workspace_id = @workspace_id AND project_id = @project_id
 AND case_id = @case_id AND attempt_id = @attempt_id AND generation = @generation
 AND owner_id = @owner_id AND supervision_token = @supervision_token AND intent_revision = @intent_revision
 AND observation_id = @observation_id AND source_attempt_id = @source_attempt_id AND source_revision = @source_revision AND snapshot_hash = @snapshot_hash AND phase='owned';

-- name: GetEngineeringNextClaimableTask :one
-- Read-only selection for recovery observation. Keep eligibility and ordering
-- in sync with ClaimAgentTask; capacity and daemon slots are checked by service.
SELECT * FROM agent_task_queue WHERE id = (
    SELECT atq.id FROM agent_task_queue atq
    WHERE atq.agent_id = @agent_id
      AND atq.runtime_id = @runtime_id
      AND atq.status = 'queued'
      AND NOT (COALESCE(atq.context,'{}'::jsonb) ? 'engineering_dispatch_hold')
      AND NOT engineering_history_project_held(COALESCE(
          (SELECT project_id FROM issue WHERE id=atq.issue_id),
          (SELECT project_id FROM chat_session WHERE id=atq.chat_session_id)))
      AND (atq.context->>'wakeup_id' IS NULL OR EXISTS (SELECT 1 FROM issue_wakeup w WHERE w.id=(atq.context->>'wakeup_id')::uuid AND w.disabled_at IS NULL AND w.revision=(atq.context->>'wakeup_revision')::bigint))
      AND EXISTS (
          SELECT 1
          FROM agent a
          JOIN agent_runtime r ON r.id = atq.runtime_id
          WHERE a.id = atq.agent_id
            -- A task's persisted runtime is not authority after an agent rebind.
            AND a.runtime_id = atq.runtime_id
            -- Queued private-runtime rows are claimable so the handler can
            -- settle an owner mismatch through the existing FailTask path
            -- before daemon delivery. Public runtimes remain shareable across
            -- agent owners; dispatched reclaim keeps its owner fence below.
            AND (
                r.visibility = 'public'
                OR r.visibility = 'private'
            )
            AND r.status = 'online'
            AND COALESCE(r.last_seen_at, r.updated_at) >=
                now() - make_interval(secs => @runtime_stale_secs::double precision)
      )
      AND NOT EXISTS (
          SELECT 1 FROM agent_task_queue active
          WHERE active.agent_id = atq.agent_id
            AND active.status IN ('dispatched', 'running', 'waiting_local_directory')
            AND (
              (atq.issue_id IS NOT NULL AND active.issue_id = atq.issue_id)
              OR (atq.chat_session_id IS NOT NULL AND active.chat_session_id = atq.chat_session_id)
              OR (
                atq.issue_id IS NULL
                AND atq.chat_session_id IS NULL
                AND atq.autopilot_run_id IS NULL
                AND active.issue_id IS NULL
                AND active.chat_session_id IS NULL
                AND active.autopilot_run_id IS NULL
              )
            )
      )
    ORDER BY atq.priority DESC, atq.created_at ASC, atq.id ASC
    LIMIT 1
);

-- name: ReserveEngineeringDispatchHold :one
-- A queue admission barrier, not a native claim, cancellation or repair fence.
UPDATE agent_task_queue SET context=jsonb_set(COALESCE(NULLIF(context,'null'::jsonb),'{}'::jsonb),'{engineering_dispatch_hold}',@receipt::jsonb)
WHERE id = sqlc.arg(task_id)::uuid AND status='queued' AND dispatched_at IS NULL AND started_at IS NULL
 AND context IS NOT DISTINCT FROM sqlc.narg(expected_context)::jsonb
 AND NOT (COALESCE(context,'{}'::jsonb) ? 'engineering_dispatch_hold') RETURNING *;
