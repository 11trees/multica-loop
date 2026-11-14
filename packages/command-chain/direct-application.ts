import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ApplicationRequest } from "./application";
import { directInstructions, directResult } from "./direct";
import { git, repositoryBranch, repositoryCommonDirectory, repositorySnapshot } from "./repository";
import { DraftConflictError } from "./runtime";

const text = z.string().trim().min(1);
const sequence = z.number().int().nonnegative();
const mode = z.enum(["in_place", "worktree"]);
const resource = z.strictObject({ path: text, mode });
const configuration = z.strictObject({ expected_revision: z.literal(0), agent_id: z.uuid(), project_id: z.uuid(),
  repository_path: text, input: z.string().refine(value => !!value.trim(), "Original work is required"), execution_resources: z.array(resource).length(1) });
const attemptSchema = z.strictObject({ id: text, repositoryPath: text, mode, branchRef: text.nullable(), boundAt: z.iso.datetime(), runAt: z.iso.datetime().optional() });
const resultSchema = z.strictObject({ id: z.uuid(), attemptId: text, summary: text.max(4000), content: text.max(100000), submittedAt: z.iso.datetime(), hash: text.regex(/^[a-f0-9]{64}$/) });
const recordSchema = z.strictObject({ workspaceId: z.uuid(), issueId: z.uuid(), projectId: z.uuid(), agentId: z.uuid(), createdBy: z.uuid(),
  revision: z.literal(1), version: sequence, repositoryPath: text, initialCommit: z.string(), input: z.string().min(1), contractHash: text, mode,
  attempts: z.array(attemptSchema), activeAttemptId: text.optional(), result: resultSchema.optional(), nativeCompleted: z.boolean() });
type Record = z.infer<typeof recordSchema>;
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function stableId(value: string) { const id = hash(value); return `${id.slice(0, 8)}-${id.slice(8, 12)}-5${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}`; }

function directory(path: string) {
  const repositoryPath = realpathSync(path);
  if (!lstatSync(repositoryPath).isDirectory()) throw new Error("Direct requires a registered local directory");
  let codeVersion = "";
  try { codeVersion = git(repositoryPath, ["rev-parse", "HEAD"]); }
  catch { /* Direct can execute work outside a Git repository. */ }
  return { repositoryPath, codeVersion };
}
function captureOverlays(root: string, overlays: { path: string; hash: string }[]) {
  const seen = new Set<string>();
  for (const overlay of overlays) {
    const file = realpathSync(overlay.path), name = relative(root, file);
    if (!name || name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name) || seen.has(name) || !lstatSync(file).isFile()) {
      throw new Error("Direct runtime overlay is outside its work directory or repeated");
    }
    seen.add(name);
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== overlay.hash) throw new Error("Direct runtime overlay changed before binding");
  }
}
/** Direct has its own two-command protocol; it does not manufacture a YAML draft. */
export class DirectApplication {
  constructor(private readonly db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS direct_contract(workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id))");
  }
  current(workspaceId: string, issueId: string): Record | undefined {
    const row = this.db.prepare("SELECT payload FROM direct_contract WHERE workspace_id=? AND issue_id=?").get(workspaceId, issueId);
    return row ? recordSchema.parse(JSON.parse(String(row.payload))) : undefined;
  }
  private save(record: Record) {
    const expected = record.version;
    record.version++;
    const changed = this.db.prepare("UPDATE direct_contract SET version=?,payload=? WHERE workspace_id=? AND issue_id=? AND version=? AND NOT EXISTS (SELECT 1 FROM engineering_intervention WHERE workspace_id=? AND issue_id=?)")
      .run(record.version, JSON.stringify(record), record.workspaceId, record.issueId, expected, record.workspaceId, record.issueId);
    if (changed.changes !== 1) throw new DraftConflictError("Direct checkpoint changed; reload its current state");
  }
  private result(record: Record) {
    if (!record.result) throw new DraftConflictError("Direct requires an explicit submitted result");
    const { hash: fingerprint, ...result } = record.result;
    if (hash({ contract: record.contractHash, ...result }) !== fingerprint || !record.attempts.some(attempt => attempt.id === result.attemptId && attempt.runAt)) {
      throw new DraftConflictError("Submitted Direct result changed or has no RUN receipt");
    }
    return record.result;
  }
  private nativeScope(record: Record) {
    const result = this.result(record);
    return { project_id: record.projectId, agent_id: record.agentId, attempt_id: result.attemptId, result_hash: result.hash };
  }
  continuations() {
    const pending = [];
    for (const row of this.db.prepare("SELECT payload FROM direct_contract root WHERE NOT EXISTS (SELECT 1 FROM engineering_intervention held WHERE held.workspace_id=root.workspace_id AND held.issue_id=root.issue_id)").all()) {
      const record = recordSchema.parse(JSON.parse(String(row.payload)));
      if (record.nativeCompleted || !record.result && record.attempts.length) continue;
      if (record.result) this.result(record);
      pending.push({ workspace_id: record.workspaceId, issue_id: record.issueId, agent_id: record.agentId, user_id: record.createdBy,
        task_id: stableId(`multica:direct:${record.issueId}:${record.contractHash}`), expected_revision: 1, expected_sequence: record.version,
        reason: record.result ? "direct_submitted" : "direct_ready" });
    }
    return pending;
  }
  private configure(request: ApplicationRequest) {
    if (request.actor.kind !== "human") throw new Error("Only a human can configure Direct");
    const input = configuration.parse(request.payload), repository = directory(input.repository_path), selected = input.execution_resources[0]!;
    if (directory(selected.path).repositoryPath !== repository.repositoryPath) throw new Error("Direct must use its registered project repository");
    if (selected.mode === "worktree" && (!repository.codeVersion || repositorySnapshot(repository.repositoryPath, false).repositoryPath !== repository.repositoryPath)) {
      throw new Error("Direct worktree mode requires a registered Git root and commit");
    }
    const record = recordSchema.parse({ workspaceId: request.actor.workspaceId, issueId: request.actor.issueId, projectId: input.project_id,
      agentId: input.agent_id, createdBy: request.actor.userId, revision: 1, version: 0, repositoryPath: repository.repositoryPath,
      initialCommit: repository.codeVersion, input: input.input, contractHash: hash({ ...input, repository_path: repository.repositoryPath }),
      mode: selected.mode, attempts: [], nativeCompleted: false });
    const changed = this.db.prepare(`INSERT INTO direct_contract(workspace_id,issue_id,version,payload)
      SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM engineering_contract WHERE workspace_id=? AND issue_id=?)
      AND NOT EXISTS(SELECT 1 FROM requirement_contract WHERE workspace_id=? AND issue_id=?)
      AND NOT EXISTS(SELECT 1 FROM requirement_unit WHERE workspace_id=? AND issue_id=?)
      AND NOT EXISTS(SELECT 1 FROM business_contract WHERE workspace_id=? AND issue_id=?) ON CONFLICT DO NOTHING`)
      .run(record.workspaceId, record.issueId, 0, JSON.stringify(record), ...Array.from({ length: 4 }, () => [record.workspaceId, record.issueId]).flat());
    if (changed.changes !== 1) throw new DraftConflictError("This issue already owns a workflow; reconcile it before replacement");
    return { configured: true };
  }
  invoke(request: ApplicationRequest) {
    const { actor, action } = request;
    if (action === "configure-direct") return this.configure(request);
    if (actor.kind === "coordinator") throw new Error("Use the Direct continuation coordinator");
    const record = this.current(actor.workspaceId, actor.issueId);
    if (!record) throw new Error("Direct is not configured");
    if (action === "selection") return { configured: actor.kind === "task" && actor.agentId === record.agentId && !record.result,
      chain: "direct", direct_project_id: record.projectId, repository_path: record.repositoryPath, code_version: directory(record.repositoryPath).codeVersion };
    if ((actor.kind === "task" || actor.kind === "daemon") && (actor.agentId !== record.agentId || actor.projectId !== record.projectId)) {
      throw new DraftConflictError("Direct native agent or original project changed");
    }
    if (action === "parent-scope") {
      if (actor.kind !== "host") throw new Error("Only the host can inspect native Direct scope");
      return { managed: false, direct_project_id: record.projectId };
    }
    if (action === "completion" || action === "direct-scope") {
      if (actor.kind !== "host") throw new Error("Only the host can inspect Direct completion");
      return { configured: true, allowed: true, direct_scope: this.nativeScope(record) };
    }
    if (action === "direct-completed") {
      if (actor.kind !== "host") throw new Error("Only the host can acknowledge native Direct completion");
      const input = z.strictObject({ result_hash: text }).parse(request.payload);
      if (this.result(record).hash !== input.result_hash) throw new DraftConflictError("Direct result changed before native completion acknowledgement");
      if (!record.nativeCompleted) { record.nativeCompleted = true; this.save(record); }
      return { acknowledged: true };
    }
    if (action === "verified-binding") throw new DraftConflictError("A Direct result is not independent delivered-code verification");
    if (action === "configure") throw new DraftConflictError("Direct input and agent are frozen; reconcile before replacement");
    if (action === "prepare-run") {
      if (actor.kind !== "human") throw new Error("Only a human can continue Direct");
      const input = z.strictObject({ expected_revision: sequence, expected_sequence: sequence, execution_resources: z.array(resource).optional() }).parse(request.payload);
      if (input.expected_revision !== 1 || input.expected_sequence !== record.version) throw new DraftConflictError("Direct checkpoint changed");
      if (record.result) throw new DraftConflictError("Direct already has its immutable submitted result");
      if (input.execution_resources && (input.execution_resources.length !== 1 || input.execution_resources.some(item => item.mode !== record.mode || directory(item.path).repositoryPath !== record.repositoryPath))) throw new Error("Direct registered repository or execution mode changed");
      return { chain: "direct", agent_id: record.agentId, revision: 1, sequence: record.version, direct_project_id: record.projectId };
    }
    if (action === "bind") {
      if (actor.kind !== "daemon") throw new Error("Only the native runtime can bind Direct");
      const input = z.strictObject({ work_dir: text, mode, overlays: z.array(z.strictObject({ path: text, hash: text })) }).parse(request.payload), root = directory(input.work_dir).repositoryPath;
      if (input.mode !== record.mode || input.mode === "worktree" && repositoryCommonDirectory(root) !== repositoryCommonDirectory(record.repositoryPath) || input.mode === "in_place" && root !== record.repositoryPath) throw new Error("Direct runtime repository or execution mode changed");
      captureOverlays(root, input.overlays);
      const previous = record.attempts.find(item => item.id === actor.attemptId), branchRef = input.mode === "worktree" ? repositoryBranch(root) : null;
      if (previous) {
        if (previous.repositoryPath !== root || previous.mode !== input.mode || previous.branchRef !== branchRef || record.activeAttemptId !== previous.id) throw new DraftConflictError("Direct attempt binding cannot be replaced or revived");
      } else {
        if (record.result) throw new DraftConflictError("Direct is already submitted; do not start another attempt");
        record.attempts.push({ id: actor.attemptId, repositoryPath: root, mode: input.mode, branchRef, boundAt: new Date().toISOString() });
        record.activeAttemptId = actor.attemptId; this.save(record);
      }
      return { bound: true, repository_path: root };
    }
    if (action === "overview" || action === "read") {
      if (actor.kind !== "human" && actor.kind !== "task") throw new Error("Authenticated Direct read is required");
      return this.view(record);
    }
    if (actor.kind !== "task") throw new Error("Direct RUN and SUBMIT require the current native task credential");
    const attempt = record.attempts.find(item => item.id === actor.attemptId);
    if (!attempt || record.activeAttemptId !== actor.attemptId) throw new DraftConflictError("Bind the current Direct attempt before RUN or SUBMIT");
    if (action === "direct-run") {
      if (!attempt.runAt && !record.result) { attempt.runAt = new Date().toISOString(); this.save(record); }
      return this.view(record);
    }
    if (action === "direct-submit") {
      if (!attempt.runAt) throw new DraftConflictError("Execute Direct RUN before SUBMIT");
      if (!record.result) {
        const value = directResult(request.payload), result = { id: randomUUID(), attemptId: actor.attemptId, ...value, submittedAt: new Date().toISOString() };
        record.result = { ...result, hash: hash({ contract: record.contractHash, ...result }) }; this.save(record);
      }
      return this.view(record);
    }
    throw new Error("Direct supports direct-run and direct-submit; it has no YAML phases or human question protocol");
  }
  private view(record: Record) {
    if (record.result) this.result(record);
    return { enabled: true, configured: true, auto_continue: true, chain: "direct", agent_id: record.agentId, revision: 1, sequence: record.version,
      code_version: record.initialCommit, repository_path: record.repositoryPath, draft_id: null,
      status: record.result ? "completed" : record.attempts.length ? "editing" : "unstarted", current_phase: null,
      phases: [], questions: [], sources: [], artifacts: [], result: null, instructions: directInstructions,
      direct: { input: record.input, project_id: record.projectId, contract_hash: record.contractHash, mode: record.mode, native_completed: record.nativeCompleted,
        attempts: record.attempts.map(item => ({ id: item.id, run_at: item.runAt ?? null, active: item.id === record.activeAttemptId })), result: record.result ?? null } };
  }
}
