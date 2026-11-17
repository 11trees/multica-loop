import { createHash } from "node:crypto";
import { browseArchive } from "./loopwork-history-lib.mjs";
import { inspectNativeSource } from "./loopwork-source-inspection.mjs";
import { captureWorkspace } from "./loopwork-workspace.mjs";

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export async function inspectRecordedWorkspaces(archive, input) {
  const saved = input.workspace_observation, record = input.record, payload = saved?.payload;
  if (saved?.hash !== input.expected_workspace_hash || digest(payload) !== saved.hash
    || payload?.format !== "loopwork-cutover-workspaces-v1" || payload.cutover_id !== record.id
    || payload.scope_hash !== record.scope_hash || payload.archive_hash !== record.archive_hash
    || payload.source_namespace !== record.source_namespace || payload.execution_authorized !== false) throw new Error("Workspace observation scope changed");
  const projects = new Map();
  for (const preparation of record.payload.preparations) {
    const { packet } = await browseArchive(archive, input.expected_hash, { action: "packet", task_id: preparation.source_task_id });
    if (packet?.hash !== preparation.packet_hash || !packet.schema_complete || packet.source_task_terminal || packet.source_project.deleted_at !== null) throw new Error("Original workspace material changed");
    const key = `${packet.source_project.id}:${preparation.project_id}`;
    if (projects.has(key)) continue;
    const observed = payload.workspaces.find(row => row.source_project_id === packet.source_project.id && row.project_id === preparation.project_id);
    if (!observed || observed.content.root !== packet.source_project.workspace_root) throw new Error("Workspace correspondence changed");
    const current = await captureWorkspace(packet.source_project.workspace_root, { timeoutMs: 10000 });
    if (digest(current) !== digest(observed.content)) throw new Error("Workspace differs from the acknowledged baseline");
    projects.set(key, { project_id: preparation.project_id, source_project_id: packet.source_project.id, root: current.root, head: current.head, dirty: current.dirty, symlinks: current.files.filter(row => row.kind === "symlink").length });
  }
  if (projects.size === 0 || projects.size !== payload.workspaces.length) throw new Error("Workspace cohort changed");
  return {workspace_hash:saved.hash,matches_saved_baseline:true,workspaces:[...projects.values()]};
}

export async function inspectActivationWorkspaces(archive, input) {
  const workspace=await inspectRecordedWorkspaces(archive,input);
  const source = await inspectNativeSource(archive, input);
  return { ...source, format: "loopwork-activation-source-inspection-v1", ...workspace };
}
