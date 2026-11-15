CREATE UNIQUE INDEX CONCURRENTLY engineering_run_process_controller_idx ON engineering_run_process(controller_id) WHERE phase<>'exited';
