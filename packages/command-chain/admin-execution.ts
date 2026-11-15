import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { DraftConflictError } from "./runtime";
import type { AdminAuthority } from "./admin-store";
const text = z.string().trim().min(1), json = (value: unknown) => JSON.stringify(value);
const check = z.strictObject({ reproductionCommand: text.max(16000), versionCheckCommand: text.max(16000), acceptanceChecks: z.array(z.strictObject({ targetRef: text, command: text, expected: text })).min(1).max(100) });
const originals = z.array(text).min(1).max(10000).refine(values => new Set(values).size === values.length, "Original observation references must be unique");
export const adminSubmissionSchema = z.discriminatedUnion("outcome", [
    z.strictObject({ outcome: z.literal("deferred"), summary: text.max(16000), nextMethod: text.max(16000) }),
    z.strictObject({ outcome: z.literal("verification-requested"), summary: text.max(16000), repairVersion: text, originalObservationIds: originals, repairEvidenceKeys: z.array(text).min(1).max(100), verification: check }),
    z.strictObject({ outcome: z.literal("diagnosis-requested"), summary: text.max(16000), baselineVersion: text, originalObservationIds: originals, verification: check }),
    z.strictObject({ outcome: z.literal("external-wait-requested"), summary: text.max(16000), dependency: text, diagnosisAttemptId: text, baselineVersion: text, originalObservationIds: originals, evidenceKey: text, retryAfterMs: z.number().int().min(30000).max(86400000) }),
]);
export const adminRuntimeSchema = z.strictObject({ provider: z.literal("codex"), executablePath: text.refine(isAbsolute, "An explicit absolute provider executable is required"), model: text.max(500).optional(), reasoningEffort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]).optional() });
const authority = z.strictObject({ ownerId: text, token: z.number().int().positive() });
export const adminClaimSchema = z.strictObject({ authority, caseId: text, attemptId: text, generation: z.number().int().positive(), sessionId: z.uuid() });
export type AdminClaim = z.infer<typeof adminClaimSchema>;
const takeoverInspectionSchema=z.strictObject({observation_id:text,snapshot_hash:text,source_attempt_id:text,project_id:z.uuid(),runtime_id:z.uuid(),registered_repository_path:text,execution_repository_path:text,mode:z.enum(["in_place","worktree"]),receipt_hash:text,code_version:z.string(),kernel_version:text.nullable(),host_version:text.nullable()});
const takeoverSchema=z.strictObject({claim:adminClaimSchema,case_id:text,observation_id:text,snapshot_hash:text,workspace_id:z.uuid(),issue_id:z.uuid(),source_attempt_id:text,reason:text,phase:z.enum(["requested","source-inspected"]),inspection:takeoverInspectionSchema.nullable()});
const attemptSchema = z.strictObject({ attemptId: text, caseId: text, ownerId: text, supervisionToken: z.number().int().positive(), generation: z.number().int().positive(), intentRevision: z.number().int().nonnegative(), sessionId: z.uuid(),
    status: z.enum(["launching", "running", "completed", "failed", "interrupted"]), pid: z.number().int().positive().nullable(), startMarker: text.nullable(), processGroupId: z.number().int().positive().nullable(),
    runtime: z.strictObject({ revision: z.number().int().positive(), configuration: adminRuntimeSchema }), statusViewed: z.boolean(), submission: adminSubmissionSchema.nullable(), startedAt: z.number(), finishedAt: z.number().nullable(), lastError: z.string().nullable(), recoveryDecision: z.strictObject({ policyVersion: z.literal(1), failedAttemptIds: z.array(text), method: z.enum(["investigate", "minimal-reproduction", "independent-diagnosis", "replan", "alternate-runtime"]), switchRuntime: z.boolean(), action: z.literal("continue-repair") }), interruptionCause: z.enum(["user-stop", "host-loss"]).optional() });
type Attempt = z.infer<typeof attemptSchema>;
type Control = {
    desired_intent: string;
    intent_revision: number;
    execution_supported: number;
};
export function initializeAdminExecution(db: DatabaseSync, version: number) {
    if (version < 2)
        db.exec("ALTER TABLE admin_control ADD COLUMN execution_supported INTEGER NOT NULL DEFAULT 0");
    db.exec(`CREATE TABLE IF NOT EXISTS admin_takeover(attempt_id TEXT PRIMARY KEY,case_id TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_runtime(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_intent_command(request_id TEXT PRIMARY KEY,action TEXT NOT NULL,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_attempt(attempt_id TEXT PRIMARY KEY,case_id TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS admin_one_live_attempt ON admin_attempt((1)) WHERE status IN ('launching','running');
 CREATE TABLE IF NOT EXISTS admin_schedule(ticket INTEGER PRIMARY KEY AUTOINCREMENT,case_id TEXT NOT NULL UNIQUE);
 INSERT OR IGNORE INTO admin_schedule(case_id) SELECT case_id FROM admin_case ORDER BY created_at,rowid;
 CREATE TABLE IF NOT EXISTS admin_evidence(attempt_id TEXT NOT NULL,receipt_key TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(attempt_id,receipt_key));`);
}
/** Host-only allocation and settlement; command identity is projected by Go. */
export class AdminExecutionStore {
    constructor(private readonly db: DatabaseSync, private readonly now: () => number, private readonly requireAuthority: (value: AdminAuthority) => Control) { }
    private transaction<T>(operation: () => T) { this.db.exec("BEGIN IMMEDIATE"); try {
        const value = operation();
        this.db.exec("COMMIT");
        return value;
    }
    catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
    } }
    configuration() { const row = this.db.prepare("SELECT revision,payload FROM admin_runtime WHERE singleton=1").get(); return row ? { revision: Number(row.revision), configuration: adminRuntimeSchema.parse(JSON.parse(String(row.payload))) } : null; }
    configure(input: unknown) {
        const value = z.strictObject({ expected_revision: z.number().int().nonnegative(), configuration: adminRuntimeSchema }).parse(input);
        return this.transaction(() => {
            const control = this.db.prepare("SELECT desired_intent FROM admin_control WHERE singleton=1").get()!;
            if (control.desired_intent !== "stopped" || this.active().length)
                throw new DraftConflictError("Stop Admin and confirm its invocation exited before changing runtime");
            const revision = this.configuration()?.revision ?? 0;
            if (revision !== value.expected_revision)
                throw new DraftConflictError("Admin runtime configuration changed");
            this.db.prepare("INSERT INTO admin_runtime VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,payload=excluded.payload").run(revision + 1, json(value.configuration));
            return { configured: true, revision: revision + 1 };
        });
    }
    setIntent(input: unknown) {
        const value = z.strictObject({ intent: z.enum(["running", "stopped"]), request_id: text }).parse(input);
        return this.transaction(() => {
            const prior = this.db.prepare("SELECT action,revision FROM admin_intent_command WHERE request_id=?").get(value.request_id);
            if (prior) {
                if (prior.action !== value.intent)
                    throw new DraftConflictError("An Admin intent request cannot be rewritten");
                return { revision: Number(prior.revision) };
            }
            if (value.intent === "running" && !this.configuration())
                throw new DraftConflictError("Configure an Admin runtime before starting");
            const row = this.db.prepare("SELECT intent_revision FROM admin_control WHERE singleton=1").get()!, revision = Number(row.intent_revision) + 1;
            this.db.prepare("UPDATE admin_control SET desired_intent=?,intent_revision=? WHERE singleton=1").run(value.intent, revision);
            this.db.prepare("INSERT INTO admin_intent_command VALUES(?,?,?)").run(value.request_id, value.intent, revision);
            return { revision };
        });
    }
    active() { return this.db.prepare("SELECT payload FROM admin_attempt WHERE status IN ('launching','running') ORDER BY rowid").all().map(row => attemptSchema.parse(JSON.parse(String(row.payload)))); }
    private read(id: string) { const row = this.db.prepare("SELECT payload FROM admin_attempt WHERE attempt_id=?").get(id); if (!row)
        throw new DraftConflictError("Admin attempt is unavailable"); return attemptSchema.parse(JSON.parse(String(row.payload))); }
    private save(attempt: Attempt) { this.db.prepare("UPDATE admin_attempt SET status=?,payload=? WHERE attempt_id=?").run(attempt.status, json(attempt), attempt.attemptId); }
    private current(input: AdminClaim, viewed = false) {
        const claim = adminClaimSchema.parse(input), control = this.requireAuthority(claim.authority), attempt = this.read(claim.attemptId), repair = this.db.prepare("SELECT current_attempt_id,generation FROM admin_case WHERE case_id=?").get(claim.caseId);
        if (!control.execution_supported || control.desired_intent !== "running" || control.intent_revision !== attempt.intentRevision || attempt.ownerId !== claim.authority.ownerId || attempt.supervisionToken !== claim.authority.token || attempt.caseId !== claim.caseId || attempt.generation !== claim.generation || attempt.sessionId !== claim.sessionId || repair?.current_attempt_id !== attempt.attemptId || Number(repair.generation) !== attempt.generation || !["launching", "running"].includes(attempt.status))
            throw new DraftConflictError("Admin invocation identity, intent or generation changed");
        if (viewed && !attempt.statusViewed)
            throw new DraftConflictError("Read Admin status before recording or submitting");
        return attempt;
    }
    claim(authority: AdminAuthority) {
        return this.transaction(() => {
            const control = this.requireAuthority(authority), runtime = this.configuration();
            if (!control.execution_supported || control.desired_intent !== "running" || !runtime || this.active().length)
                return null;
            const repair = this.db.prepare("SELECT root.case_id,root.generation FROM admin_case root JOIN admin_schedule queue USING(case_id) WHERE root.status='queued' AND root.current_attempt_id IS NULL ORDER BY queue.ticket LIMIT 1").get();
            if (!repair)
                return null;
            const failed = this.db.prepare("SELECT payload FROM admin_attempt WHERE case_id=? ORDER BY rowid").all(String(repair.case_id)).map(row => attemptSchema.parse(JSON.parse(String(row.payload)))).filter(attempt => attempt.status === "failed" || attempt.status === "interrupted" && attempt.interruptionCause === "host-loss").map(attempt => attempt.attemptId);
            const method = (["investigate", "minimal-reproduction", "independent-diagnosis", "replan", "alternate-runtime"] as const)[Math.min(Math.floor(failed.length / 2), 4)]!;
            const attempt: Attempt = { attemptId: `ADMIN-${randomUUID()}`, caseId: String(repair.case_id), ownerId: authority.ownerId, supervisionToken: authority.token, generation: Number(repair.generation) + 1, intentRevision: control.intent_revision, sessionId: randomUUID(), status: "launching", pid: null, startMarker: null, processGroupId: null, runtime, statusViewed: false, submission: null, recoveryDecision: { policyVersion: 1, failedAttemptIds: failed, method, switchRuntime: false, action: "continue-repair" }, startedAt: this.now(), finishedAt: null, lastError: null };
            this.db.prepare("INSERT INTO admin_attempt VALUES(?,?,?,?)").run(attempt.attemptId, attempt.caseId, attempt.status, json(attempt));
            this.db.prepare("UPDATE admin_case SET current_attempt_id=?,generation=?,status='running',updated_at=? WHERE case_id=?").run(attempt.attemptId, attempt.generation, this.now(), attempt.caseId);
            this.db.prepare("DELETE FROM admin_schedule WHERE case_id=?").run(attempt.caseId);
            this.db.prepare("INSERT INTO admin_schedule(case_id) VALUES(?)").run(attempt.caseId);
            return { claim: { authority, caseId: attempt.caseId, attemptId: attempt.attemptId, generation: attempt.generation, sessionId: attempt.sessionId }, attempt };
        });
    }
    bind(claim: AdminClaim, input: unknown) { const value = z.strictObject({ pid: z.number().int().positive(), marker: text, group_id: z.number().int().positive() }).parse(input); return this.transaction(() => { const attempt = this.current(claim); if (value.group_id !== value.pid || attempt.pid !== null && (attempt.pid !== value.pid || attempt.startMarker !== value.marker || attempt.processGroupId !== value.group_id))
        throw new DraftConflictError("Admin process identity cannot be replaced"); attempt.pid = value.pid; attempt.startMarker = value.marker; attempt.processGroupId = value.group_id; attempt.status = "running"; this.save(attempt); return { bound: true }; }); }
    command(claim: AdminClaim, input: unknown) {
        const value = z.discriminatedUnion("action", [
            z.strictObject({ action: z.literal("status") }),
            z.strictObject({ action: z.literal("workspace-takeover"), observation_id: text, reason: text.max(16000) }),
            z.strictObject({ action: z.literal("history"), collection: z.enum(["observations", "evidence", "attempts"]), index: z.number().int().nonnegative(), start: z.number().int().nonnegative(), length: z.number().int().min(1).max(16000), hash: text.optional() }),
            z.strictObject({ action: z.literal("evidence"), key: text, kind: z.enum(["hypothesis", "finding", "action", "change"]), payload: z.record(z.string(), z.unknown()) }),
            z.strictObject({ action: z.literal("submit"), result: adminSubmissionSchema }),
        ]).parse(input);
        return this.transaction(() => {
            const attempt = this.current(claim, value.action !== "status");
            if (value.action === "status") {
                attempt.statusViewed = true;
                this.save(attempt);
                const history = Object.fromEntries((["observations", "evidence", "attempts"] as const).map(collection => { const reader = this.history(attempt.caseId, collection), budget = collection === "observations" ? 16000 : collection === "evidence" ? 8000 : 6000; let remaining = budget; const rows = []; for (let index = 0; index < reader.total && remaining > 0; index++) {
                    const content = json(reader.read(index)), preview = content.slice(0, remaining);
                    rows.push({ index, text: preview, length: content.length, hash: createHash("sha256").update(content).digest("hex") });
                    remaining -= preview.length;
                } return [collection, { total: reader.total, rows }]; }));
                return { attempt, history, takeover: this.takeover(attempt.attemptId), requiredOriginalObservationIds: this.db.prepare("SELECT observation_id FROM admin_observation WHERE case_id=? AND origin<>'admin' ORDER BY rowid").all(attempt.caseId).map(row => String(row.observation_id)), agent_action: attempt.submission ? "end_execution" : "investigate" };
            }
            if (value.action === "workspace-takeover") {
                if (attempt.submission) throw new DraftConflictError("Admin already submitted; end execution");
                const row = this.db.prepare("SELECT payload FROM admin_observation WHERE observation_id=? AND case_id=? AND origin='business'").get(value.observation_id, attempt.caseId);
                if (!row) throw new DraftConflictError("Takeover must reference this Case's original business observation");
                const source = z.object({workspaceId:z.uuid(),issueId:z.uuid(),evidence:z.object({original:z.object({observationId:text,snapshotHash:text,attemptId:text})})}).parse(JSON.parse(String(row.payload)));
                if(source.evidence.original.observationId !== value.observation_id) throw new DraftConflictError("Original observation identity changed");
                const prior=this.takeover(attempt.attemptId);
                if(prior){if(prior.observation_id!==value.observation_id || prior.reason!==value.reason)throw new DraftConflictError("Takeover request cannot be replaced");return prior;}
                const request=takeoverSchema.parse({claim,case_id:attempt.caseId,observation_id:value.observation_id,snapshot_hash:source.evidence.original.snapshotHash,workspace_id:source.workspaceId,issue_id:source.issueId,source_attempt_id:source.evidence.original.attemptId,reason:value.reason,phase:"requested",inspection:null});
                this.db.prepare("INSERT INTO admin_takeover VALUES(?,?,?)").run(attempt.attemptId,attempt.caseId,json(request));
                return request;
            }
            if (value.action === "history") {
                const row = this.history(attempt.caseId, value.collection).read(value.index);
                if (!row)
                    throw new Error("Admin history index is unavailable");
                const content = json(row), hash = createHash("sha256").update(content).digest("hex");
                if (value.hash && value.hash !== hash)
                    throw new DraftConflictError("Admin history row changed; reload its exact hash");
                return { content: content.slice(value.start, value.start + value.length), length: content.length, hash };
            }
            if (value.action === "evidence") {
                if (attempt.submission)
                    throw new DraftConflictError("Admin already submitted; end execution");
                const payload = json(value.payload);
                this.db.prepare("INSERT INTO admin_evidence VALUES(?,?,?,?) ON CONFLICT(attempt_id,receipt_key) DO NOTHING").run(attempt.attemptId, value.key, value.kind, payload);
                const prior = this.db.prepare("SELECT kind,payload FROM admin_evidence WHERE attempt_id=? AND receipt_key=?").get(attempt.attemptId, value.key)!;
                if (prior.kind !== value.kind || prior.payload !== payload)
                    throw new DraftConflictError("Recorded repair evidence cannot be replaced");
                return { recorded: true };
            }
            if (attempt.submission) {
                if (json(attempt.submission) !== json(value.result))
                    throw new DraftConflictError("Submitted Admin result cannot be rewritten");
                return { submitted: true, agent_action: "end_execution" };
            }
            if (value.result.outcome === "verification-requested" || value.result.outcome === "diagnosis-requested")
                throw new DraftConflictError("Work-item repair requires a confirmed scoped workspace takeover before independent verification");
            if (value.result.outcome === "external-wait-requested")
                throw new DraftConflictError("External wait requires a persisted independent diagnosis");
            attempt.submission = value.result;
            this.save(attempt);
            return { submitted: true, agent_action: "end_execution" };
        });
    }
    private takeover(attemptId:string) {const row=this.db.prepare("SELECT payload FROM admin_takeover WHERE attempt_id=?").get(attemptId);return row ? takeoverSchema.parse(JSON.parse(String(row.payload))) : null;}
    pendingTakeovers(authority:AdminAuthority) {
        this.requireAuthority(authority);
        return this.active().flatMap(attempt=>{const request=this.takeover(attempt.attemptId);if(!request)return [];try{const current=this.current(adminClaimSchema.parse(request.claim));if(current.submission)return [];return [request];}catch{return [];}});
    }
    currentTakeover(claim:AdminClaim) {
        const attempt=this.current(claim,true),request=this.takeover(claim.attemptId);
        if(attempt.submission || !request || request.phase!=="source-inspected")throw new DraftConflictError("Takeover source is not inspected or invocation already submitted");
        return {request,intent_revision:attempt.intentRevision};
    }
    inspectTakeover(claim:AdminClaim,input:unknown) {
        const inspection=takeoverInspectionSchema.parse(input);
        return this.transaction(()=>{this.current(claim,true);const request=this.takeover(claim.attemptId);
            if(!request || request.observation_id!==inspection.observation_id || request.snapshot_hash!==inspection.snapshot_hash || request.source_attempt_id!==inspection.source_attempt_id)throw new DraftConflictError("Takeover inspection belongs to another original source");
            if(request.inspection && json(request.inspection)!==json(inspection))throw new DraftConflictError("Takeover inspection cannot be replaced");
            request.inspection=inspection;request.phase="source-inspected";
            this.db.prepare("UPDATE admin_takeover SET payload=? WHERE attempt_id=?").run(json(request),claim.attemptId);return request;
        });
    }
    private history(caseId: string, collection: "observations" | "evidence" | "attempts") {
        const from = collection === "observations" ? "admin_observation" : collection === "attempts" ? "admin_attempt" : "admin_evidence JOIN admin_attempt USING(attempt_id)";
        const order = collection === "evidence" ? "admin_evidence.rowid" : "rowid", columns = collection === "evidence" ? "admin_evidence.attempt_id,receipt_key,kind,admin_evidence.payload" : "payload";
        const total = Number(this.db.prepare(`SELECT count(*) AS n FROM ${from} WHERE case_id=?`).get(caseId)!.n), read = this.db.prepare(`SELECT ${columns} FROM ${from} WHERE case_id=? ORDER BY ${order} LIMIT 1 OFFSET ?`);
        return { total, read: (index: number) => { const row = read.get(caseId, index); if (!row)
                return undefined; return collection === "evidence" ? { ...row, payload: JSON.parse(String(row.payload)) } : JSON.parse(String(row.payload)); } };
    }
    finish(claim: AdminClaim, input: unknown) { const value = z.strictObject({ exit_confirmed: z.boolean(), reason: text }).parse(input); return this.transaction(() => { const attempt = this.current(claim); if (!value.exit_confirmed) {
        attempt.lastError = value.reason;
        this.save(attempt);
        return { settled: false };
    } attempt.status = "failed"; attempt.finishedAt = this.now(); attempt.lastError = attempt.submission?.summary ?? value.reason; this.save(attempt); this.db.prepare("UPDATE admin_case SET current_attempt_id=NULL,status='queued',updated_at=? WHERE case_id=?").run(this.now(), attempt.caseId); return { settled: true }; }); }
    retire(authority: AdminAuthority, input: unknown) { const value = z.strictObject({ attempt_id: text, exit_confirmed: z.boolean(), pid: z.number().int().nonnegative(), marker: z.string(), owned_launch: z.boolean().optional().default(false), reason: text }).parse(input); return this.transaction(() => { const control = this.requireAuthority(authority), attempt = this.read(value.attempt_id); if (!value.exit_confirmed)
        return { retired: false }; if (!["launching", "running"].includes(attempt.status))
        return { retired: true }; if (attempt.pid === null ? !(value.owned_launch && attempt.ownerId === authority.ownerId && attempt.supervisionToken === authority.token) : attempt.pid !== value.pid || attempt.startMarker !== value.marker)
        throw new DraftConflictError("Exit proof belongs to another process identity"); const repair = this.db.prepare("SELECT current_attempt_id FROM admin_case WHERE case_id=?").get(attempt.caseId); if (repair?.current_attempt_id !== attempt.attemptId)
        throw new DraftConflictError("Exit proof belongs to another Case generation"); attempt.status = "interrupted"; attempt.finishedAt = this.now(); attempt.lastError = value.reason; attempt.interruptionCause = control.desired_intent === "stopped" ? "user-stop" : "host-loss"; this.save(attempt); this.db.prepare("UPDATE admin_case SET current_attempt_id=NULL,status='queued',updated_at=? WHERE case_id=?").run(this.now(), attempt.caseId); return { retired: true }; }); }
}
