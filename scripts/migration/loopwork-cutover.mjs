import pg from "pg";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { freezeCutover, holdCutover, observeCutoverProcesses, planCutover, probeCutoverSource, rollbackCutover, statusCutover } from "./loopwork-cutover-lib.mjs";

export async function main(args, env = process.env) {
  const [action, flag, value, ...extra] = args;
  if (extra.length || !["plan", "probe", "hold", "status", "freeze", "observe", "rollback"].includes(action) || (["plan", "probe"].includes(action) ? flag !== undefined : !value || flag !== (action === "hold" ? "--expected-scope" : "--id"))) throw new Error("Usage: plan|probe | hold --expected-scope sha256 | status|freeze|observe|rollback --id native-cutover-uuid");
  if (!["plan", "probe"].includes(action) && !(action === "hold" ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).test(value)) throw new Error("Invalid cutover identity");
  const archive = env.MULTICA_LOOPWORK_HISTORY_ARCHIVE, hash = env.MULTICA_LOOPWORK_HISTORY_HASH;
  if (!archive || !/^[a-f0-9]{64}$/.test(hash ?? "") || !env.DATABASE_URL) throw new Error("Use the managed environment with its pinned history archive and native database");
  const destination = new URL(env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(destination.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname)) throw new Error("This operator tool only supports the local single-user database");
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  try {
    await client.connect();
    if (action === "probe") return await probeCutoverSource(client, archive, hash);
    if (action === "plan") {
      const plan = await planCutover(client, archive, hash);
      return { ...plan, payload: undefined, source_tasks: plan.payload.preparations.map(row => ({ source_task_id: row.source_task_id, preparation_id: row.id, revision: row.revision })), database_cohort: plan.payload.source.preimages.map(row => ({ name: row.name, tables: row.tables.length, rows: row.rows })), physical_quiescence_confirmed: false };
    }
    if (action === "hold") return await holdCutover(client, archive, hash, value);
    // Status and mutations remain bound to the environment's configured hash.
    const existing = await client.query("SELECT archive_hash FROM engineering_history_cutover WHERE id=$1", [value]);
    if (existing.rows[0]?.archive_hash !== hash) throw new Error("Cutover differs from the configured archive; restore its original configuration");
    return await ({ status: statusCutover, freeze: freezeCutover, observe: observeCutoverProcesses, rollback: rollbackCutover })[action](client, archive, value);
  } finally { await client.end(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + "\n")).catch(() => {
  // Driver/SQLite diagnostics can embed original query values or credentials.
  process.stderr.write("Cutover refused or interrupted. Native execution remains held if a hold was committed; inspect the same cutover before retrying.\n");
  process.exitCode = 1;
});
