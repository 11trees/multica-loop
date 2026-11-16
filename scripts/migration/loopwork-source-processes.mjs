import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectSourceFence, prepareSourceFence, sourceCohort, sourceNamespace } from "./loopwork-source-fence.mjs";

const execute = promisify(execFile);
const normalize = value => value.trim().replace(/\s+/g, " ");
const specs = [
  ["business", "loop_managed_processes", "process_id", "process_start_marker", null, "registered_at"],
  ["business", "execution_processes", "allocation_id", "process_start_marker", "process_group_id", "created_at"],
  ["management", "repair_attempts", "attempt_id", "start_marker", "process_group_id", "started_at"],
  ...["admin_business_worker_processes", "admin_harness_build_processes", "admin_runtime_host_processes", "admin_runtime_ui_processes", "admin_runtime_cli_processes", "admin_runtime_update_processes"].map(table => ["management", table, "allocation_id", "marker", "group_id", null]),
];

async function command(path, args) {
  return execute(path, args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
}
async function bootIdentity() {
  if (process.platform === "darwin") {
    const [{ stdout: id }, { stdout: time }] = await Promise.all([command("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]), command("/usr/sbin/sysctl", ["-n", "kern.boottime"])]);
    const match = time.match(/sec\s*=\s*(\d+)/);
    if (!/^[a-f0-9-]{36}$/i.test(id.trim()) || !match) throw new Error("Host boot identity is unavailable");
    return { id: id.trim(), started_at: Number(match[1]) * 1000 };
  }
  if (process.platform === "linux") {
    const [id, stat] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile("/proc/stat", "utf8")]);
    const match = stat.match(/^btime (\d+)$/m);
    if (!/^[a-f0-9-]{36}$/i.test(id.trim()) || !match) throw new Error("Host boot identity is unavailable");
    return { id: id.trim(), started_at: Number(match[1]) * 1000 };
  }
  throw new Error("Source process observation supports local macOS/Linux hosts only");
}

export function parseHostProcesses(output) {
  const rows = output.trim().split(/\r?\n/).map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || !Number.isFinite(Date.parse(match[4]))) throw new Error("Host process snapshot is incomplete");
    return { pid: Number(match[1]), parent_pid: Number(match[2]), group_id: Number(match[3]), marker: normalize(match[4]) };
  });
  if (!rows.length || new Set(rows.map(row => row.pid)).size !== rows.length) throw new Error("Host process snapshot is incomplete");
  return rows;
}
function fileHolders(output, watched) {
  const holders = [], allowed = new Set(watched); let pid = null;
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith("n")) {
      if (!pid || !allowed.has(line.slice(1))) throw new Error("Database holder snapshot is incomplete");
      holders.push({ pid, path: line.slice(1) });
    } else if (!line.startsWith("f")) throw new Error("Database holder snapshot is incomplete");
  }
  return holders;
}

// Only OS inspection commands run here. No command line, environment, provider
// discovery, process signal or source SQLite open is needed for this receipt.
export async function observeSourceHost(paths) {
  const before = await bootIdentity(), watched = [], canonicalPaths = await Promise.all(paths.map(path => realpath(path)));
  for (const path of canonicalPaths) for (const suffix of ["", "-wal", "-shm"]) {
    const target = path + suffix;
    const stat = await lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Source database holder path changed");
    watched.push(target);
  }
  if (!canonicalPaths.every(path => watched.includes(path))) throw new Error("A source database disappeared before host observation");
  const { stdout: processOutput, stderr: processError } = await command("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="]);
  if (processError.trim()) throw new Error("Host process observation failed");
  const processes = parseHostProcesses(processOutput);
  if (!processes.some(row => row.pid === process.pid)) throw new Error("Host process inventory omitted the observer");
  let holderOutput = "";
  try {
    const result = await command(process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof", ["-nP", "-F", "pfn", "--", ...watched]);
    if (result.stderr.trim()) throw new Error("Database holder snapshot emitted a warning");
    holderOutput = result.stdout;
  }
  catch (error) {
    if (error.code !== 1 || error.stdout || error.stderr) throw new Error("Database holder observation failed");
  }
  const after = await bootIdentity();
  if (before.id !== after.id || before.started_at !== after.started_at) throw new Error("Host boot changed during observation");
  return { platform: process.platform, boot: after, observed_at: new Date().toISOString(), processes, database_holders: fileHolders(holderOutput, watched) };
}

function sqliteTime(value) {
  if (typeof value !== "string") return NaN;
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)) return Date.parse(value.replace(" ", "T") + "Z");
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
}
export function assessSourceProcesses(writers, runs, host) {
  const blockers = [], byPID = new Map(host.processes.map(row => [row.pid, row]));
  if (!Number.isFinite(host.boot?.started_at) || !host.boot.id || !Number.isFinite(Date.parse(host.observed_at)) || Date.parse(host.observed_at) < host.boot.started_at) throw new Error("Invalid host observation");
  const results = writers.map(writer => {
    const marker = typeof writer.marker === "string" ? normalize(writer.marker) : "", birth = Date.parse(marker), current = byPID.get(writer.pid);
    let state = "unconfirmed";
    if (current && marker && current.marker === marker) state = "alive";
    // A later local boot also excludes orphaned/escaped descendants. A missing
    // PID or terminal database status alone cannot establish that property.
    else if (Number.isSafeInteger(writer.pid) && writer.pid > 0 && Number.isFinite(birth) && birth < host.boot.started_at && Number.isFinite(sqliteTime(writer.registered_at)) && sqliteTime(writer.registered_at) < host.boot.started_at) state = "exited_before_host_boot";
    if (state !== "exited_before_host_boot") blockers.push({ code: state === "alive" ? "recorded_writer_alive" : "recorded_writer_unconfirmed", table: writer.table, id: writer.id });
    return { table: writer.table, id: writer.id, pid: writer.pid, state };
  });
  for (const run of runs) if (!Number.isFinite(sqliteTime(run.started_at)) || sqliteTime(run.started_at) >= host.boot.started_at || !["stopped", "crashed"].includes(run.status)) blockers.push({ code: "source_run_not_retired_before_boot", id: run.id });
  if (host.database_holders.length) blockers.push({ code: "source_database_open", pids: [...new Set(host.database_holders.map(row => row.pid))].sort((a, b) => a - b) });
  return { scope: "local_loopwork_registered_writers", method: "later_host_boot_and_closed_databases", host: { platform: host.platform, boot_id: host.boot.id, boot_started_at: new Date(host.boot.started_at).toISOString(), observed_at: host.observed_at }, writers: results, source_runs: runs.length, database_holder_count: host.database_holders.length, blockers, registered_writers_quiesced: blockers.length === 0, execution_authorized: false };
}

export async function probeSourceProcesses(archive, expectedHash, record = null, inspectHost = observeSourceHost) {
  const { manifest, entries } = await sourceCohort(archive, expectedHash), writers = [], runs = [];
  const verifySource = async () => {
    if (record) {
      const fence = await inspectSourceFence(archive, record);
      if (fence.state !== "frozen") throw new Error("Source process receipt requires the entire cohort frozen");
    } else await prepareSourceFence(archive, expectedHash);
  };
  await verifySource();
  for (const entry of manifest.databases) {
    const db = new DatabaseSync(join(archive, entry.file), { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
      for (const [role, table, id, marker, group, time] of specs.filter(spec => spec[0] === entry.role)) {
        const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name));
        if (![id, "pid", marker, ...(group ? [group] : []), ...(time ? [time] : [])].every(column => columns.has(column))) throw new Error("Source writer schema is incomplete");
        for (const row of db.prepare(`SELECT "${id}" AS id,pid,"${marker}" AS marker,${group ? `"${group}"` : "NULL"} AS group_id,${time ? `"${time}"` : "NULL"} AS registered_at FROM "${table}" ORDER BY "${id}"`).all()) writers.push({ table, ...row });
      }
      if (entry.role === "business") runs.push(...db.prepare("SELECT run_id AS id,status,started_at FROM loop_runs ORDER BY run_id").all());
    } finally { db.close(); }
  }
  const host = await inspectHost(entries.map(entry => entry.path));
  await verifySource();
  return { source_namespace: sourceNamespace(manifest), archive_hash: manifest.hash, source_frozen: !!record, ...assessSourceProcesses(writers, runs, host), physical_quiescence_confirmed: false };
}
