CREATE UNIQUE INDEX CONCURRENTLY engineering_run_scope_live_idx ON engineering_run_guard(workspace_id,scope_kind,scope_id) WHERE phase<>'quiesced';
