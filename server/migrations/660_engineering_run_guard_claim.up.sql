CREATE UNIQUE INDEX CONCURRENTLY engineering_run_guard_claim_idx ON engineering_run_guard(task_id,runtime_id,claim_at) WHERE phase<>'quiesced';
