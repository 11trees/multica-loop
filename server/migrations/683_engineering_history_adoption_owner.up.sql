CREATE UNIQUE INDEX CONCURRENTLY engineering_history_adoption_owner_idx ON engineering_history_adoption(workspace_id,source_namespace,source_task_id) WHERE phase IN ('staged','activated');
