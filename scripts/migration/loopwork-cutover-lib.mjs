import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { browseArchive, verifyArchive } from "./loopwork-history-lib.mjs";
import { changeSourceFence, cutoverDigest, inspectSourceFence, prepareSourceFence, sourceNamespace } from "./loopwork-source-fence.mjs";
import { probeSourceProcesses } from "./loopwork-source-processes.mjs";
import { captureWorkspace } from "./loopwork-workspace.mjs";

export const cutoverWorkspace = "323d1db3-abcf-4890-a2ca-df15a057fdf7";
export const cutoverHuman = "db20ef47-8076-41a0-af0d-2814950fbe42";
const identity = record => ({ id: record.id, archive_hash: record.archive_hash, source_namespace: record.source_namespace, scope_hash: record.scope_hash, preimages: record.payload.source.preimages });
const projection = record => ({ id: record.id, archive_hash: record.archive_hash, source_namespace: record.source_namespace, scope_hash: record.scope_hash, phase: record.phase, project_ids: record.project_ids, execution_authorized: false, physical_quiescence_confirmed: false });

async function transaction(client, fn) {
  await client.query("BEGIN");
  try { const result = await fn(); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}
async function authorized(client) {
  const member = await client.query("SELECT 1 FROM member WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin')", [cutoverWorkspace, cutoverHuman]);
  if (member.rowCount !== 1) throw new Error("Cutover requires the reserved local human workspace owner");
}
async function noAdoption(client, projects, stagedCutover = null) {
  const result = await client.query(`SELECT
    EXISTS(SELECT 1 FROM issue i WHERE project_id=ANY($1::uuid[]) AND NOT EXISTS(
      SELECT 1 FROM engineering_history_adoption a WHERE a.issue_id=i.id AND a.workspace_id=$2::uuid
      AND (a.phase='withdrawn' AND i.status='cancelled' OR a.phase='staged' AND a.cutover_id=$3::uuid))) AS issues,
    EXISTS(SELECT 1 FROM chat_session WHERE project_id=ANY($1::uuid[])) AS chats,
    EXISTS(SELECT 1 FROM project_resource WHERE project_id=ANY($1::uuid[])) AS resources,
    EXISTS(SELECT 1 FROM engineering_run_guard WHERE project_id=ANY($1::uuid[])) AS controllers,
    EXISTS(SELECT 1 FROM engineering_repair_fence WHERE project_id=ANY($1::uuid[])) AS repairs,
    EXISTS(SELECT 1 FROM engineering_history_adoption a JOIN engineering_history_preparation p ON p.id=a.preparation_id
      WHERE p.project_id=ANY($1::uuid[]) AND a.phase='staged' AND a.cutover_id IS DISTINCT FROM $3::uuid) AS staged,
    EXISTS(SELECT 1 FROM engineering_repair_handoff WHERE project_id=ANY($1::uuid[])) AS handoffs`, [projects,cutoverWorkspace,stagedCutover]);
  if (Object.values(result.rows[0]).some(Boolean)) throw new Error("Initial cutover/rollback requires empty prepared native projects; reconcile existing adoption explicitly");
}

export async function planCutover(client, archive, expectedHash) {
  await authorized(client);
  const manifest = await verifyArchive(archive);
  if (manifest.hash !== expectedHash) throw new Error("Cutover archive identity changed");
  const business = manifest.databases.find(row => row.role === "business"), db = new DatabaseSync(join(archive, business.file), { readOnly: true });
  let tasks;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    tasks = db.prepare("SELECT t.task_id FROM tasks t JOIN projects p ON p.project_id=t.project_id WHERE p.deleted_at IS NULL AND t.agile_status NOT IN ('done','cancelled') ORDER BY t.task_id").all();
  } finally { db.close(); }
  if (!tasks.length) throw new Error("No active unfinished source tasks require cutover");
  const namespace = sourceNamespace(manifest), preparations = [];
  for (const task of tasks) {
    const { packet } = await browseArchive(archive, expectedHash, { action: "packet", task_id: task.task_id });
    if (!packet || packet.source_project.deleted_at !== null || packet.source_task_terminal || !packet.schema_complete) throw new Error("Incomplete source task material");
    const result = await client.query("SELECT * FROM engineering_history_preparation WHERE workspace_id=$1 AND source_namespace=$2 AND source_task_id=$3 ORDER BY revision DESC LIMIT 1", [cutoverWorkspace, namespace, task.task_id]);
    const saved = result.rows[0];
    if (!saved || saved.archive_hash !== expectedHash || saved.packet_hash !== packet.hash || saved.payload.packet?.hash !== packet.hash || saved.payload.execution_authorized !== false) throw new Error("Every active source task needs its current native preparation");
    preparations.push({ id: saved.id, revision: saved.revision, source_task_id: task.task_id, packet_hash: packet.hash, project_id: saved.project_id, team_id: saved.team_id, team_revision: saved.team_revision });
  }
  const projects = [...new Set(preparations.map(row => row.project_id))].sort();
  await noAdoption(client, projects);
  const source = await prepareSourceFence(archive, expectedHash);
  const payload = { format: "loopwork-cutover-hold-v1", source, preparations };
  return { archive_hash: expectedHash, source_namespace: namespace, scope_hash: stableDigest(payload), project_ids: projects, payload, execution_authorized: false };
}

export async function holdCutover(client, archive, expectedHash, expectedScope) {
  return transaction(client, async () => {
    await authorized(client);
    const manifest = await verifyArchive(archive), namespace = sourceNamespace(manifest);
    if (manifest.hash !== expectedHash) throw new Error("Cutover archive identity changed");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`loopwork-cutover:${cutoverWorkspace}:${namespace}`]);
    const prior = await client.query("SELECT * FROM engineering_history_cutover WHERE workspace_id=$1 AND source_namespace=$2 AND phase<>'cancelled'", [cutoverWorkspace, namespace]);
    if (prior.rowCount) {
      if (prior.rows[0].scope_hash !== expectedScope || prior.rows[0].archive_hash !== expectedHash) throw new Error("A different cutover already holds this source");
      return projection(prior.rows[0]);
    }
    const plan = await planCutover(client, archive, expectedHash);
    if (plan.scope_hash !== expectedScope) throw new Error("Cutover plan changed; review a fresh plan");
    // Preparation creation uses these same source-project locks. Freeze the
    // proposed versions with the admission barrier, without creating issues.
    const sourceProjects = [...new Set(plan.payload.preparations.map(row => row.source_task_id))];
    const sourceRows = await client.query("SELECT DISTINCT source_project_id FROM engineering_history_preparation WHERE id=ANY($1::uuid[]) ORDER BY source_project_id", [plan.payload.preparations.map(row => row.id)]);
    for (const row of sourceRows.rows) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${cutoverWorkspace}:${plan.source_namespace}:${row.source_project_id}`]);
    for (const project of plan.project_ids) await client.query("SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [project, cutoverWorkspace]);
    await noAdoption(client, plan.project_ids);
    for (const task of sourceProjects) {
      const latest = await client.query("SELECT id FROM engineering_history_preparation WHERE workspace_id=$1 AND source_namespace=$2 AND source_task_id=$3 ORDER BY revision DESC LIMIT 1", [cutoverWorkspace, namespace, task]);
      if (latest.rows[0]?.id !== plan.payload.preparations.find(row => row.source_task_id === task).id) throw new Error("Preparation changed before cutover hold");
    }
    const result = await client.query("INSERT INTO engineering_history_cutover(workspace_id,source_namespace,archive_hash,scope_hash,project_ids,prepared_by,payload) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [cutoverWorkspace, namespace, expectedHash, expectedScope, plan.project_ids, cutoverHuman, plan.payload]);
    return projection(result.rows[0]);
  });
}

async function record(client, id, lock = false) {
  await authorized(client);
  const result = await client.query(`SELECT * FROM engineering_history_cutover WHERE id=$1 AND workspace_id=$2${lock ? " FOR UPDATE" : ""}`, [id, cutoverWorkspace]);
  if (result.rowCount !== 1) throw new Error("Native cutover record is unavailable");
  const saved = result.rows[0];
  if (stableDigest(saved.payload) !== saved.scope_hash) throw new Error("Native cutover scope changed");
  return saved;
}
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
export const stableDigest = value => cutoverDigest(canonical(value));

// Capture current source workspaces without copying, resetting or accepting
// their code. Paths come from the pinned source packets, never CLI input.
export async function observeCutoverWorkspaces(client, archive, id, expectedWorkspaceHash = null, inspectHost) {
  return transaction(client, async () => {
    const saved = await record(client, id, true);
    if (saved.phase !== "source_frozen") throw new Error("Workspace observation requires the frozen phase");
    await noAdoption(client, saved.project_ids, id);
    if ((await inspectSourceFence(archive, identity(saved))).state !== "frozen") throw new Error("Workspace observation requires the entire source frozen");
    const previous = saved.receipt?.workspace_observations ?? [];
    if (previous.some(row => stableDigest(row.payload) !== row.hash || row.payload.cutover_id !== id || row.payload.scope_hash !== saved.scope_hash)) throw new Error("Saved workspace observation changed");
    if (expectedWorkspaceHash && previous.at(-1)?.hash !== expectedWorkspaceHash) throw new Error("Expected workspace baseline is not the latest saved observation");
    const workspaces = [], projects = new Set();
    for (const preparation of saved.payload.preparations) {
      const native = await client.query("SELECT * FROM engineering_history_preparation WHERE id=$1 AND workspace_id=$2", [preparation.id, cutoverWorkspace]);
      const row = native.rows[0];
      const { packet } = await browseArchive(archive, saved.archive_hash, { action: "packet", task_id: preparation.source_task_id });
      if (!row || row.project_id !== preparation.project_id || row.packet_hash !== preparation.packet_hash
        || row.archive_hash !== saved.archive_hash || row.source_namespace !== saved.source_namespace
        || row.source_task_id !== preparation.source_task_id || row.revision !== preparation.revision
        || row.team_id !== preparation.team_id || row.team_revision !== preparation.team_revision
        || row.source_project_id !== packet?.source_project.id || row.payload.packet?.hash !== packet?.hash
        || packet?.hash !== preparation.packet_hash || !packet.schema_complete || packet.source_project.deleted_at !== null) {
        throw new Error("Workspace preparation or original packet changed");
      }
      const key = `${packet.source_project.id}:${row.project_id}`;
      if (projects.has(key)) continue;
      projects.add(key);
      workspaces.push({ source_project_id: packet.source_project.id, project_id: row.project_id, content: await captureWorkspace(packet.source_project.workspace_root) });
    }
    if (!workspaces.length) throw new Error("Cutover has no prepared workspace");
    const proof = await probeSourceProcesses(archive, saved.archive_hash, identity(saved), inspectHost);
    if (!proof.registered_writers_quiesced) throw new Error("Source registered writers require reconciliation");
    const payload = { format: "loopwork-cutover-workspaces-v1", cutover_id: id, scope_hash: saved.scope_hash, archive_hash: saved.archive_hash, source_namespace: saved.source_namespace, workspaces, execution_authorized: false };
    const hash = stableDigest(payload);
    const latest = previous.at(-1);
    if (expectedWorkspaceHash && (stableDigest(latest.payload) !== expectedWorkspaceHash || hash !== expectedWorkspaceHash)) throw new Error("Workspace differs from the saved baseline; preserve changes and review a new observation");
    if (!expectedWorkspaceHash && latest?.hash !== hash) {
      previous.push({ hash, observed_at: new Date().toISOString(), payload });
      await client.query("UPDATE engineering_history_cutover SET receipt=$2,updated_at=now() WHERE id=$1", [id, { ...saved.receipt, workspace_observations: previous }]);
    }
    return { ...projection(saved), workspace_hash: hash, matches_saved_baseline: expectedWorkspaceHash ? true : null, workspaces: workspaces.map(({ source_project_id, project_id, content }) => ({ source_project_id, project_id, root: content.root, head: content.head, dirty: content.dirty, files: content.files.length, untracked_files: content.untracked_count, deleted_files: content.deleted_count, symlinks: content.files.filter(row => row.kind === "symlink").length })), registered_writers_quiesced: true };
  });
}

export async function probeCutoverSource(client, archive, expectedHash) {
  await authorized(client);
  return probeSourceProcesses(archive, expectedHash);
}
export async function observeCutoverProcesses(client, archive, id, inspectHost) {
  return transaction(client, async () => {
    const saved = await record(client, id, true);
    if (saved.phase !== "source_frozen") throw new Error("Source process observation requires the frozen phase");
    await noAdoption(client, saved.project_ids,id);
    const proof = await probeSourceProcesses(archive, saved.archive_hash, identity(saved), inspectHost);
    if (!proof.registered_writers_quiesced) throw new Error("Source registered writers require reconciliation");
    const observation = { cutover_id: id, scope_hash: saved.scope_hash, proof };
    const hash = stableDigest(observation), previous = saved.receipt?.physical_observations ?? [];
    const receipt = { ...saved.receipt, physical_observations: previous.some(row => row.hash === hash) ? previous : [...previous, { hash, ...observation }] };
    await client.query("UPDATE engineering_history_cutover SET receipt=$2,updated_at=now() WHERE id=$1", [id, receipt]);
    return { ...projection(saved), source_processes: proof, observation_hash: hash };
  });
}

export async function statusCutover(client, archive, id) {
  const saved = await record(client, id);
  if (saved.phase === "cancelled") return { ...projection(saved), source: saved.receipt, source_inspected_now: false, source_observed_at: saved.updated_at };
  try { return { ...projection(saved), source: await inspectSourceFence(archive, identity(saved)), source_inspected_now: true }; }
  catch { return { ...projection(saved), source: { state: "reconciliation_required", execution_authorized: false, physical_quiescence_confirmed: false }, source_inspected_now: false }; }
}
export async function freezeCutover(client, archive, id) {
  return transaction(client, async () => {
    const saved = await record(client, id, true);
    if (!["held", "source_frozen"].includes(saved.phase)) throw new Error("Cutover cannot freeze in this phase");
    await noAdoption(client, saved.project_ids,id);
    const receipt = await changeSourceFence(archive, identity(saved), "freeze", async () => {
      const current = await record(client, id, true);
      if (current.phase !== saved.phase) throw new Error("Native cutover barrier changed");
    });
    if (receipt.state !== "frozen") throw new Error("Source cohort is not fully frozen");
    await client.query("UPDATE engineering_history_cutover SET phase='source_frozen',receipt=$2,updated_at=now() WHERE id=$1", [id, { ...receipt, physical_observations: saved.receipt?.physical_observations ?? [], workspace_observations: saved.receipt?.workspace_observations ?? [] }]);
    return { ...projection({ ...saved, phase: "source_frozen" }), source: receipt };
  });
}
export async function rollbackCutover(client, archive, id) {
  // Commit rollback intent before touching any SQLite file. Crash recovery
  // resumes this same record; no rollback phase can admit native execution.
  await transaction(client, async () => {
    const saved = await record(client, id, true);
    if (saved.phase === "cancelled") return;
    await noAdoption(client, saved.project_ids);
    await client.query("UPDATE engineering_history_cutover SET phase='rollback_pending',updated_at=now() WHERE id=$1", [id]);
  });
  return transaction(client, async () => {
    const saved = await record(client, id, true);
    if (saved.phase === "cancelled") return projection(saved);
    if (saved.phase !== "rollback_pending") throw new Error("Rollback intent is missing");
    const receipt = await changeSourceFence(archive, identity(saved), "restore", async () => {
      if ((await record(client, id, true)).phase !== "rollback_pending") throw new Error("Native rollback barrier changed");
      await noAdoption(client, saved.project_ids);
    });
    if (receipt.state !== "unfenced") throw new Error("Source cohort is still fenced");
    await noAdoption(client, saved.project_ids);
    await client.query("UPDATE engineering_history_cutover SET phase='cancelled',receipt=$2,updated_at=now() WHERE id=$1", [id, { ...receipt, physical_observations: saved.receipt?.physical_observations ?? [], workspace_observations: saved.receipt?.workspace_observations ?? [] }]);
    return { ...projection({ ...saved, phase: "cancelled" }), source: receipt };
  });
}
