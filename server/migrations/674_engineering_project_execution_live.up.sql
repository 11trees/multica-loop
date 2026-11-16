CREATE UNIQUE INDEX CONCURRENTLY engineering_project_execution_live_idx ON engineering_run_guard(project_id) WHERE project_serialized AND (phase<>'quiesced' OR NOT claim_settled);
