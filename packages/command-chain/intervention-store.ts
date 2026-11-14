import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ApplicationRequest } from "./application";
import { DraftConflictError, draftSchema } from "./runtime";

const text = z.string().trim().min(1);
export const interventionRequestSchema = z.strictObject({ summary: text.max(4000), reason: text.max(8000), evidence: text.max(100000) });
const viewedSchema = z.strictObject({ chain: text, revision: z.number().int().positive(), draftId: text.nullable(), attemptId: text, agentId: z.uuid(), snapshot: z.record(z.string(), z.unknown()) });
const recordSchema = z.strictObject({ id: z.uuid(), workspaceId: z.uuid(), issueId: z.uuid(), agentId: z.uuid(), attemptId: text,
  chain: text, phase: text, draftId: text.nullable(), revision: z.number().int().positive(), sequence: z.number().int().nonnegative(),
  summary: text.max(4000), reason: text.max(8000), evidence: text.max(100000), requestedAt: z.iso.datetime(),
  snapshot: z.unknown(), snapshotHash: text, requestHash: text, observationId: text, receiptHash: text, kernelVersion: text.optional(), hostVersion: text.optional(),
});
type Record = z.infer<typeof recordSchema>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");

export function initializeInterventions(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_intervention (
    workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,attempt_id TEXT NOT NULL,draft_id TEXT,payload TEXT NOT NULL,
    PRIMARY KEY(workspace_id,issue_id,attempt_id));
    CREATE TABLE IF NOT EXISTS engineering_intervention_view (
    workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,attempt_id TEXT NOT NULL,payload TEXT NOT NULL,
    PRIMARY KEY(workspace_id,issue_id,attempt_id));
    CREATE TABLE IF NOT EXISTS engineering_intervention_delivery(observation_id TEXT PRIMARY KEY,case_id TEXT NOT NULL,snapshot_hash TEXT NOT NULL)`);
}

/** The immutable terminal receipt is also the durable pending Admin observation. */
export class InterventionStore {
  constructor(private readonly db: DatabaseSync, private readonly kernelVersion?: string) { initializeInterventions(db); }
  pending(workspaceId: string, issueId: string) {
    const row = this.db.prepare("SELECT payload FROM engineering_intervention WHERE workspace_id=? AND issue_id=?").get(workspaceId, issueId);
    return row ? this.parse(row.payload) : undefined;
  }
  private parse(payload: unknown) {
    const record = recordSchema.parse(JSON.parse(String(payload)));
    const { receiptHash, ...original } = record;
    if (hash(original) !== receiptHash) throw new DraftConflictError("Intervention identity or receipt changed");
    if (hash(record.snapshot) !== record.snapshotHash || hash({ summary: record.summary, reason: record.reason, evidence: record.evidence }) !== record.requestHash) {
      throw new DraftConflictError("Intervention receipt or original checkpoint changed");
    }
    return record;
  }
  private checkpoint(actor: Extract<ApplicationRequest["actor"], { kind: "task" }>, snapshot: unknown) {
    const value = z.object({ chain: text, draft: z.object({ id: text, status: text, phase: text.nullable(), sequence: z.number().int().nonnegative(), attemptId: text,
      binding: z.object({ revision: z.number().int().positive() }) }).nullable().optional(),
      revision: z.number().int().positive().optional(), sequence: z.number().int().nonnegative().optional(),
      direct: z.object({ result: z.unknown().nullable(), attempts: z.array(z.object({ id: text, active: z.boolean(), run_at: z.string().nullable() })) }).optional(),
    }).parse(snapshot);
    if (value.chain === "direct") {
      if (!value.direct || value.direct.result || !value.direct.attempts.some(attempt => attempt.id === actor.attemptId && attempt.active && attempt.run_at)) {
        throw new DraftConflictError("Execute Direct RUN before requesting intervention; submitted work cannot surrender execution");
      }
      return { chain: value.chain, revision: value.revision!, sequence: value.sequence!, draftId: null, phase: "run", attemptId: actor.attemptId };
    }
    if (!value.draft || value.draft.attemptId !== actor.attemptId || value.draft.status !== "editing" || !value.draft.phase) {
      throw new DraftConflictError("Intervention requires this attempt's current editable draft");
    }
    return { chain: value.chain, revision: value.draft.binding.revision, sequence: value.draft.sequence, draftId: value.draft.id, phase: value.draft.phase, attemptId: actor.attemptId };
  }
  viewed(actor: ApplicationRequest["actor"], snapshot: unknown) {
    if (actor.kind !== "task") return;
    // A completed or unanswered checkpoint is readable, but cannot authorize surrender.
    let checkpoint;
    try { checkpoint = this.checkpoint(actor, snapshot); } catch { return; }
    const { chain, revision, draftId, attemptId } = checkpoint;
    this.db.prepare("INSERT INTO engineering_intervention_view VALUES(?,?,?,?) ON CONFLICT(workspace_id,issue_id,attempt_id) DO UPDATE SET payload=excluded.payload")
      .run(actor.workspaceId, actor.issueId, actor.attemptId, JSON.stringify({ chain, revision, draftId, attemptId, agentId: actor.agentId, snapshot }));
  }
  snapshot(actor: Extract<ApplicationRequest["actor"], { kind: "task" }>) {
    const row = this.db.prepare("SELECT payload FROM engineering_intervention_view WHERE workspace_id=? AND issue_id=? AND attempt_id=?").get(actor.workspaceId, actor.issueId, actor.attemptId);
    if (!row) throw new DraftConflictError("Read this attempt's editable checkpoint before requesting intervention");
    const viewed = viewedSchema.parse(JSON.parse(String(row.payload)));
    if (viewed.agentId !== actor.agentId || !viewed.draftId) throw new DraftConflictError("The viewed draft belongs to another role or protocol");
    const saved = this.db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(viewed.draftId);
    if (!saved) throw new DraftConflictError("The viewed editable draft is unavailable");
    const draft = draftSchema.parse(JSON.parse(String(saved.payload)));
    // A fault may itself be a changed/dirty readonly repository. Capture persisted
    // scope without rerunning normal repository validators before surrender.
    const receipts = this.db.prepare("SELECT payload FROM engineering_receipt WHERE draft_id=?").all(draft.id).map(row => JSON.parse(String(row.payload)));
    return { ...viewed.snapshot, draft, instructions: undefined, receipts };
  }
  request(actor: ApplicationRequest["actor"], input: unknown, snapshot: unknown, hostVersion?:string) {
    if (actor.kind !== "task") throw new Error("Only the current native task can surrender its execution");
    const body = interventionRequestSchema.parse(input), existing = this.pending(actor.workspaceId, actor.issueId);
    if (existing) {
      if (existing.attemptId !== actor.attemptId || existing.agentId !== actor.agentId || existing.requestHash !== hash(body)) {
        throw new DraftConflictError("Intervention already submitted; its immutable request cannot be replaced");
      }
      return this.receipt(existing);
    }
    const checkpoint = this.checkpoint(actor, snapshot);
    const row = this.db.prepare("SELECT payload FROM engineering_intervention_view WHERE workspace_id=? AND issue_id=? AND attempt_id=?").get(actor.workspaceId, actor.issueId, actor.attemptId);
    const viewed = row ? viewedSchema.parse(JSON.parse(String(row.payload))) : undefined;
    if (!viewed || viewed.agentId !== actor.agentId || viewed.chain !== checkpoint.chain || viewed.revision !== checkpoint.revision || viewed.draftId !== checkpoint.draftId) {
      throw new DraftConflictError("Read this attempt's editable checkpoint before requesting intervention");
    }
    const original = { ...body, ...checkpoint, ...(this.kernelVersion ? { kernelVersion: this.kernelVersion } : {}), ...(hostVersion ? {hostVersion} : {}), id: randomUUID(), workspaceId: actor.workspaceId, issueId: actor.issueId,
      agentId: actor.agentId, requestedAt: new Date().toISOString(), snapshot, snapshotHash: hash(snapshot), requestHash: hash(body),
      observationId: `multica:role-request:${actor.workspaceId}:${actor.issueId}:${actor.attemptId}` };
    const record = recordSchema.parse({ ...original, receiptHash: hash(original) });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (record.draftId) {
        const draft = this.db.prepare("SELECT sequence FROM chain_drafts WHERE id=?").get(record.draftId);
        if (draft?.sequence !== record.sequence) throw new DraftConflictError("Draft changed before intervention handoff");
      } else {
        const direct = this.db.prepare("SELECT version FROM direct_contract WHERE workspace_id=? AND issue_id=?").get(record.workspaceId, record.issueId);
        if (direct?.version !== record.sequence) throw new DraftConflictError("Direct changed before intervention handoff");
      }
      if (this.pending(record.workspaceId, record.issueId)) throw new DraftConflictError("Intervention was submitted concurrently");
      this.db.prepare("INSERT INTO engineering_intervention VALUES(?,?,?,?,?)").run(record.workspaceId, record.issueId, record.attemptId, record.draftId, JSON.stringify(record));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.receipt(record);
  }
  receipt(record: Record) { return { submitted: true, owner: "admin", agent_action: "end_execution", intervention: this.view(record) }; }
  view(record: Record) { return { id: record.id, status: "pending_admin", chain: record.chain, phase: record.phase, draft_id: record.draftId,
    revision: record.revision, sequence: record.sequence, attempt_id: record.attemptId, agent_id: record.agentId,
    summary: record.summary, reason: record.reason, evidence: record.evidence, requested_at: record.requestedAt,
    observation_id: record.observationId, snapshot_hash: record.snapshotHash }; }
  acknowledge(workspaceId: string, issueId: string, input: unknown) {
    const value = z.strictObject({ observation_id: text, case_id: text, snapshot_hash: text }).parse(input), current = this.pending(workspaceId, issueId);
    if (!current || current.observationId !== value.observation_id || current.snapshotHash !== value.snapshot_hash) throw new DraftConflictError("Admin acknowledgement must pin the original observation");
    this.db.prepare("INSERT INTO engineering_intervention_delivery VALUES(?,?,?) ON CONFLICT(observation_id) DO NOTHING").run(value.observation_id, value.case_id, value.snapshot_hash);
    const saved = this.db.prepare("SELECT case_id,snapshot_hash FROM engineering_intervention_delivery WHERE observation_id=?").get(value.observation_id)!;
    if (saved.case_id !== value.case_id || saved.snapshot_hash !== value.snapshot_hash) throw new DraftConflictError("Observation cannot be linked to another Admin Case");
    return { acknowledged: true };
  }
  observations() { return this.db.prepare("SELECT payload FROM engineering_intervention source WHERE NOT EXISTS (SELECT 1 FROM engineering_intervention_delivery delivery WHERE delivery.observation_id=json_extract(source.payload,'$.observationId')) ORDER BY rowid LIMIT 25").all().map(row => this.parse(row.payload)); }
}

export const interventionInstructions = "When unable to reconcile a blocker reliably, first read the editable checkpoint (Direct: direct-run), then use multica engineering intervention-request --summary-file <task-temp-file> --reason-file <task-temp-file> --evidence-file <task-temp-file>. An accepted request surrenders this execution to the independent Admin repair path. End execution immediately; preserve the draft and evidence. Do not declare completion, change the oracle or retry the same request with different content.";
