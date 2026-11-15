DROP TRIGGER engineering_resource_mutation ON project_resource;
DROP TRIGGER engineering_issue_project_mutation ON issue;
DROP TRIGGER engineering_project_mutation ON project;
DROP TRIGGER engineering_controller_admission ON engineering_run_guard;
DROP TRIGGER engineering_task_admission ON agent_task_queue;
DROP FUNCTION engineering_guard_project_mutation();
DROP FUNCTION engineering_guard_controller_admission();
DROP FUNCTION engineering_guard_task_admission();
DROP FUNCTION engineering_require_project_available(UUID);
