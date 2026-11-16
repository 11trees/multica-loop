CREATE UNIQUE INDEX CONCURRENTLY engineering_history_cutover_scope_idx ON engineering_history_cutover(workspace_id,source_namespace) WHERE phase<>'cancelled';
