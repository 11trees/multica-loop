import { repairHandoffTargetSchema,handoffPreparationSchema,handoffReservationSchema,handoffApplicationSchema,handoffHash,type HandoffReservation,type HandoffApplication,type RepairHandoffTarget } from "./repair-handoff";
import { independentCheckSchema, independentCheckResultSchema, independentCheckSteps, independentCheckPassed, compileIndependentReceipt, independentReceiptSchema } from "./repair-verification-receipt";
import { authorizeRepairPlan, preparedRepairPlanSchema } from "./repair-verification-plan";
import { originalRepairTargets, repairContentVersionSchema, repairVerificationInputHash, repairVerificationInputSchema } from "./repair-verification-input";
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
    z.strictObject({ outcome: z.literal("verification-requested"), summary: text.max(16000), repairVersion: repairContentVersionSchema, originalObservationIds: originals, repairEvidenceKeys: z.array(text).min(1).max(100), verification: check }),
    z.strictObject({ outcome: z.literal("diagnosis-requested"), summary: text.max(16000), baselineVersion: text, originalObservationIds: originals, verification: check }),
    z.strictObject({ outcome: z.literal("external-wait-requested"), summary: text.max(16000), dependency: text, diagnosisAttemptId: text, baselineVersion: text, originalObservationIds: originals, evidenceKey: text, retryAfterMs: z.number().int().min(30000).max(86400000) }),
]);
export const adminRuntimeSchema = z.strictObject({ provider: z.literal("codex"), executablePath: text.refine(isAbsolute, "An explicit absolute provider executable is required"), model: text.max(500).optional(), reasoningEffort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]).optional() });
const authority = z.strictObject({ ownerId: text, token: z.number().int().positive() });
export const adminClaimSchema = z.strictObject({ authority, caseId: text, attemptId: text, generation: z.number().int().positive(), sessionId: z.uuid() });
export type AdminClaim = z.infer<typeof adminClaimSchema>;
const takeoverInspectionSchema=z.strictObject({observation_id:text,snapshot_hash:text,source_attempt_id:text,project_id:z.uuid(),runtime_id:z.uuid(),registered_repository_path:text,execution_repository_path:text,mode:z.enum(["in_place","worktree"]),receipt_hash:text,code_version:z.string(),kernel_version:text.nullable(),host_version:text.nullable()});
const takeoverProgressSchema=z.strictObject({phase:z.enum(["draining","owned"]),cancelled:z.number().int().nonnegative(),unfinished_controllers:z.number().int().nonnegative(),unknown_tasks:z.number().int().nonnegative(),targets_hash:text.regex(/^[a-f0-9]{64}$/),workspace_root:text.nullable(),workspace_version:repairContentVersionSchema.nullable().default(null),source_attempt_id:text,snapshot_hash:text});
const takeoverSchema=z.strictObject({claim:adminClaimSchema,case_id:text,observation_id:text,snapshot_hash:text,workspace_id:z.uuid(),issue_id:z.uuid(),source_attempt_id:text,reason:text,phase:z.enum(["requested","source-inspected"]),inspection:takeoverInspectionSchema.nullable()});
const nativeHash = text.regex(/^[a-f0-9]{64}$/);
const candidateKey = text.regex(/^[a-zA-Z0-9._:-]{1,80}$/);
const writeGrantBody = z.strictObject({claim:adminClaimSchema,intentRevision:z.number().int().positive(),pid:z.number().int().positive(),marker:text,source:takeoverInspectionSchema,targetsHash:nativeHash,workspaceRoot:text,baselineVersion:repairContentVersionSchema,originalObservationIds:originals,reason:text.max(16000)});
const candidateBody = z.strictObject({grantHash:nativeHash,key:candidateKey,evidenceKey:text,version:repairContentVersionSchema});
const writeGrantSchema=z.strictObject({body:writeGrantBody,hash:nativeHash});
const candidateSchema=z.strictObject({body:candidateBody,hash:nativeHash});
const nativeReceiptHash=(body:unknown)=>createHash("sha256").update(json(body)).digest("hex");
const attemptSchema = z.strictObject({ role:z.enum(["investigation","verification","verification-execution"]).default("investigation"), verification:z.strictObject({sourceRepairAttemptId:text,inputHash:text,sourcePreparationAttemptId:text.optional(),planHash:text.optional()}).optional(), attemptId: text, caseId: text, ownerId: text, supervisionToken: z.number().int().positive(), generation: z.number().int().positive(), intentRevision: z.number().int().nonnegative(), sessionId: z.uuid(),
    status: z.enum(["waiting", "launching", "running", "completed", "failed", "interrupted"]), pid: z.number().int().positive().nullable(), startMarker: text.nullable(), processGroupId: z.number().int().positive().nullable(),
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
    if (version < 6) db.exec("DROP INDEX IF EXISTS admin_one_live_attempt");
    if(version<8) db.exec("UPDATE admin_case SET status='queued' WHERE current_attempt_id IS NULL AND status IN ('verifying','verification-prepared','verified')");
    db.exec(`CREATE TABLE IF NOT EXISTS admin_handoff_application(case_id TEXT NOT NULL,verification_attempt_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(case_id,verification_attempt_id));
    CREATE TABLE IF NOT EXISTS admin_handoff_reservation(case_id TEXT NOT NULL,verification_attempt_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(case_id,verification_attempt_id));
    CREATE TABLE IF NOT EXISTS admin_handoff_preparation(case_id TEXT NOT NULL,verification_attempt_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(case_id,verification_attempt_id));
 CREATE TABLE IF NOT EXISTS admin_repair_write(attempt_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_repair_candidate(attempt_id TEXT NOT NULL,receipt_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(attempt_id,receipt_key));
 CREATE TABLE IF NOT EXISTS admin_verification_check(attempt_id TEXT NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(attempt_id,ordinal));
 CREATE TABLE IF NOT EXISTS admin_verification_receipt(attempt_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_verification_plan(attempt_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_verification_input(attempt_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_takeover_progress(attempt_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_takeover(attempt_id TEXT PRIMARY KEY,case_id TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_runtime(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_intent_command(request_id TEXT PRIMARY KEY,action TEXT NOT NULL,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_attempt(attempt_id TEXT PRIMARY KEY,case_id TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS admin_one_live_attempt ON admin_attempt((1)) WHERE status IN ('waiting','launching','running');
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
    active() { return this.db.prepare("SELECT payload FROM admin_attempt WHERE status IN ('waiting','launching','running') ORDER BY rowid").all().map(row => attemptSchema.parse(JSON.parse(String(row.payload)))); }
    private read(id: string) { const row = this.db.prepare("SELECT payload FROM admin_attempt WHERE attempt_id=?").get(id); if (!row)
        throw new DraftConflictError("Admin attempt is unavailable"); return attemptSchema.parse(JSON.parse(String(row.payload))); }
    private save(attempt: Attempt) { this.db.prepare("UPDATE admin_attempt SET status=?,payload=? WHERE attempt_id=?").run(attempt.status, json(attempt), attempt.attemptId); }
    private current(input: AdminClaim, viewed = false) {
        const claim = adminClaimSchema.parse(input), control = this.requireAuthority(claim.authority), attempt = this.read(claim.attemptId), repair = this.db.prepare("SELECT current_attempt_id,generation FROM admin_case WHERE case_id=?").get(claim.caseId);
        if (!control.execution_supported || control.desired_intent !== "running" || control.intent_revision !== attempt.intentRevision || attempt.ownerId !== claim.authority.ownerId || attempt.supervisionToken !== claim.authority.token || attempt.caseId !== claim.caseId || attempt.generation !== claim.generation || attempt.sessionId !== claim.sessionId || repair?.current_attempt_id !== attempt.attemptId || Number(repair.generation) !== attempt.generation || !["waiting", "launching", "running"].includes(attempt.status))
            throw new DraftConflictError("Admin invocation identity, intent or generation changed");
        if (viewed && attempt.role === "investigation" && !attempt.statusViewed)
            throw new DraftConflictError("Read Admin status before recording or submitting");
        return attempt;
    }
    claim(authority: AdminAuthority) {
        return this.transaction(() => {
            const control = this.requireAuthority(authority), runtime = this.configuration();
            if (!control.execution_supported || control.desired_intent !== "running" || !runtime || this.active().length)
                return null;
            const repair = this.db.prepare("SELECT root.case_id,root.generation,root.status FROM admin_case root JOIN admin_schedule queue USING(case_id) WHERE root.status IN ('queued','verifying','verification-prepared') AND root.current_attempt_id IS NULL ORDER BY queue.ticket LIMIT 1").get();
            if (!repair)
                return null;
            const source = repair.status !== "queued" ? this.verificationSource(String(repair.case_id)) : null;
            const preparation=repair.status==="verification-prepared" ? this.preparationSource(String(repair.case_id),source!.hash) : null;
            const failed = this.db.prepare("SELECT payload FROM admin_attempt WHERE case_id=? ORDER BY rowid").all(String(repair.case_id)).map(row => attemptSchema.parse(JSON.parse(String(row.payload)))).filter(attempt => attempt.status === "failed" || attempt.status === "interrupted" && attempt.interruptionCause === "host-loss").map(attempt => attempt.attemptId);
            const method = (["investigate", "minimal-reproduction", "independent-diagnosis", "replan", "alternate-runtime"] as const)[Math.min(Math.floor(failed.length / 2), 4)]!;
            const attempt: Attempt = { role:preparation ? "verification-execution" : source ? "verification" : "investigation", ...(source?{verification:{sourceRepairAttemptId:source.input.sourceRepairAttemptId,inputHash:source.hash,...(preparation?{sourcePreparationAttemptId:preparation.attemptId,planHash:preparation.hash}:{})}}:{}), attemptId: `ADMIN-${randomUUID()}`, caseId: String(repair.case_id), ownerId: authority.ownerId, supervisionToken: authority.token, generation: Number(repair.generation) + 1, intentRevision: control.intent_revision, sessionId: randomUUID(), status: source ? "waiting" : "launching", pid: null, startMarker: null, processGroupId: null, runtime, statusViewed: false, submission: null, recoveryDecision: { policyVersion: 1, failedAttemptIds: failed, method, switchRuntime: false, action: "continue-repair" }, startedAt: this.now(), finishedAt: null, lastError: null };
            this.db.prepare("INSERT INTO admin_attempt VALUES(?,?,?,?)").run(attempt.attemptId, attempt.caseId, attempt.status, json(attempt));
            this.db.prepare("UPDATE admin_case SET current_attempt_id=?,generation=?,status='running',updated_at=? WHERE case_id=?").run(attempt.attemptId, attempt.generation, this.now(), attempt.caseId);
            this.db.prepare("DELETE FROM admin_schedule WHERE case_id=?").run(attempt.caseId);
            this.db.prepare("INSERT INTO admin_schedule(case_id) VALUES(?)").run(attempt.caseId);
            const claim = {authority,caseId:attempt.caseId,attemptId:attempt.attemptId,generation:attempt.generation,sessionId:attempt.sessionId};
            if(source){
                const original=this.takeover(source.input.sourceRepairAttemptId);
                if(!original)throw new DraftConflictError("Original repair takeover unavailable");
                const request=takeoverSchema.parse({...original,claim});
                this.db.prepare("INSERT INTO admin_takeover VALUES(?,?,?)").run(attempt.attemptId,attempt.caseId,json(request));
            }
            return { claim, attempt };
        });
    }
    bind(claim: AdminClaim, input: unknown) { const value = z.strictObject({ pid: z.number().int().positive(), marker: text, group_id: z.number().int().positive() }).parse(input); return this.transaction(() => { const attempt = this.current(claim); if(attempt.status==="waiting")throw new DraftConflictError("Verification needs a durable launch reservation"); if (value.group_id !== value.pid || attempt.pid !== null && (attempt.pid !== value.pid || attempt.startMarker !== value.marker || attempt.processGroupId !== value.group_id))
        throw new DraftConflictError("Admin process identity cannot be replaced"); attempt.pid = value.pid; attempt.startMarker = value.marker; attempt.processGroupId = value.group_id; attempt.status = "running"; this.save(attempt); return { bound: true }; }); }
    command(claim: AdminClaim, input: unknown) {
        const value = z.discriminatedUnion("action", [
            z.strictObject({ action: z.literal("status") }),
            z.strictObject({ action:z.literal("workspace-write"),reason:text.max(16000) }),
            z.strictObject({ action:z.literal("workspace-candidate"),key:candidateKey }),
            z.strictObject({ action: z.literal("workspace-takeover"), observation_id: text, reason: text.max(16000) }),
            z.strictObject({ action: z.literal("history"), collection: z.enum(["observations", "evidence", "attempts"]), index: z.number().int().nonnegative(), start: z.number().int().nonnegative(), length: z.number().int().min(1).max(16000), hash: text.optional() }),
            z.strictObject({ action: z.literal("evidence"), key: text, kind: z.enum(["hypothesis", "finding", "action", "change"]), payload: z.record(z.string(), z.unknown()) }),
            z.strictObject({ action: z.literal("submit"), result: adminSubmissionSchema }),
        ]).parse(input);
        return this.transaction(() => {
            const attempt = this.current(claim, value.action !== "status");
            if(attempt.role!=="investigation")throw new DraftConflictError("Independent Test has no Admin command authority");
            if (value.action === "status") {
                attempt.statusViewed = true;
                this.save(attempt);
                const history = Object.fromEntries((["observations", "evidence", "attempts"] as const).map(collection => { const reader = this.history(attempt.caseId, collection), budget = collection === "observations" ? 16000 : collection === "evidence" ? 8000 : 6000; let remaining = budget; const rows = []; for (let index = 0; index < reader.total && remaining > 0; index++) {
                    const content = json(reader.read(index)), preview = content.slice(0, remaining);
                    rows.push({ index, text: preview, length: content.length, hash: createHash("sha256").update(content).digest("hex") });
                    remaining -= preview.length;
                } return [collection, { total: reader.total, rows }]; }));
                const prepared = this.verificationInput(attempt.attemptId);
                return { attempt, history, repairWrite:this.repairWrite(attempt.attemptId), repairCandidates:this.repairCandidates(attempt.attemptId), takeover: this.takeover(attempt.attemptId), takeoverProgress: this.progress(attempt.attemptId), verificationInput: prepared ? {hash:prepared.hash,expectedVersion:prepared.input.expectedVersion,targetCount:prepared.input.targets.length} : null, requiredOriginalObservationIds: this.db.prepare("SELECT observation_id FROM admin_observation WHERE case_id=? AND origin<>'admin' ORDER BY rowid").all(attempt.caseId).map(row => String(row.observation_id)), agent_action: attempt.submission ? "end_execution" : "investigate" };
            }
            if(value.action==="workspace-write"||value.action==="workspace-candidate"){
                this.repairWriteContext(claim);
                return {host_required:true};
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
                if(value.key.startsWith("native-candidate/"))throw new DraftConflictError("Native candidate evidence is reserved for the host");
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
            if (value.result.outcome === "verification-requested") this.validateVerificationSubmission(attempt, value.result);
            if (value.result.outcome === "diagnosis-requested")
                throw new DraftConflictError("Independent diagnosis is not connected");
            if (value.result.outcome === "external-wait-requested")
                throw new DraftConflictError("External wait requires a persisted independent diagnosis");
            attempt.submission = value.result;
            this.save(attempt);
            return { submitted: true, agent_action: "end_execution" };
        });
    }
    private verificationSource(caseId:string){
        const rows=this.db.prepare("SELECT payload FROM admin_attempt WHERE case_id=? ORDER BY rowid DESC").all(caseId);
        for(const row of rows){const attempt=attemptSchema.parse(JSON.parse(String(row.payload)));
            if(attempt.role==="investigation" && attempt.status==="completed" && attempt.finishedAt!==null && attempt.submission?.outcome==="verification-requested"){
                const source=this.verificationInput(attempt.attemptId);if(source)return source;
            }
        }
        throw new DraftConflictError("Verification has no physically settled repair source");
    }
    verificationCurrent(claim:AdminClaim,requireOwned=false){
        const attempt=this.current(claim);
        if(attempt.role==="investigation" || !attempt.verification)throw new DraftConflictError("Invocation is not an independent Test");
        const source=this.verificationInput(attempt.verification.sourceRepairAttemptId),repair=this.read(attempt.verification.sourceRepairAttemptId);
        if(!source || source.hash!==attempt.verification.inputHash || repair.caseId!==attempt.caseId || repair.role!=="investigation" || repair.status!=="completed" || repair.finishedAt===null || repair.submission?.outcome!=="verification-requested")throw new DraftConflictError("Original repair source is not physically settled");
        const ids=this.originalObservations(attempt.caseId).map(row=>String(row.observationId)).sort();
        if(json(ids)!==json(source.input.originalObservations.map(row=>row.observationId).sort()))throw new DraftConflictError("Original observations changed before independent Test");
        const progress=this.progress(attempt.attemptId),binding=source.input.workspaceBinding;
        const ready=progress?.phase==="owned" && progress.workspace_root===binding.workspaceRoot && progress.workspace_version===source.input.expectedVersion && progress.targets_hash===binding.targetsHash && progress.source_attempt_id===binding.sourceAttemptId && progress.snapshot_hash===binding.snapshotHash;
        if(requireOwned&&!ready)throw new DraftConflictError("Independent Test source is not currently owned at the frozen version");
        const execution=attempt.role==="verification-execution"?this.executionBasis(claim):null;
        return {attempt,input:source.input,input_hash:source.hash,ready,progress,...(execution?{plan:execution.plan,plan_hash:execution.planHash}:{})};
    }
    launchVerification(claim:AdminClaim){return this.transaction(()=>{
        const {attempt}=this.verificationCurrent(claim,true);
        if(attempt.status!=="waiting" || attempt.pid!==null)throw new DraftConflictError("Independent Test launch already reserved");
        attempt.status="launching";this.save(attempt);return {reserved:true};
    });}
    cancelWaitingVerification(authority:AdminAuthority,attemptId:string){return this.transaction(()=>{
        const control=this.requireAuthority(authority),attempt=this.read(text.parse(attemptId));
        if(attempt.role==="investigation"||attempt.status!=="waiting"||attempt.pid!==null)throw new DraftConflictError("Only a never-launched waiting Test can be cancelled without exit proof");
        const repair=this.db.prepare("SELECT current_attempt_id FROM admin_case WHERE case_id=?").get(attempt.caseId);
        if(repair?.current_attempt_id!==attempt.attemptId)throw new DraftConflictError("Waiting Test generation changed");
        let unchanged=false;
        try{const source=attempt.verification?this.verificationInput(attempt.verification.sourceRepairAttemptId):null;unchanged=!!source&&json(this.originalObservations(attempt.caseId).map(row=>String(row.observationId)).sort())===json(source.input.originalObservations.map(row=>row.observationId).sort());}catch{ /* Invalid source stays in the original repair Case. */ }
        attempt.status="interrupted";attempt.finishedAt=this.now();attempt.lastError="Waiting independent Test was never launched";attempt.interruptionCause=control.desired_intent==="stopped"?"user-stop":"host-loss";this.save(attempt);
        this.db.prepare("UPDATE admin_case SET current_attempt_id=NULL,status=?,updated_at=? WHERE case_id=?").run(unchanged?(attempt.role==="verification-execution"?"verification-prepared":"verifying"):"queued",this.now(),attempt.caseId);return {cancelled:true};
    });}
    readVerificationPlan(authority:AdminAuthority,attemptId:string){this.requireAuthority(authority);return this.verificationPlan(text.parse(attemptId));}
    verificationPlan(attemptId:string){const row=this.db.prepare("SELECT payload FROM admin_verification_plan WHERE attempt_id=?").get(attemptId);return row?preparedRepairPlanSchema.parse(JSON.parse(String(row.payload))):null;}
    recordVerificationPlan(claim:AdminClaim,raw:unknown){const payload=z.strictObject({proposed:z.unknown(),artifacts:z.unknown()}).parse(raw);return this.transaction(()=>{
        const {attempt,input,input_hash}=this.verificationCurrent(claim,true);
        if(attempt.role!=="verification"||attempt.status!=="running"||!attempt.pid||!attempt.startMarker)throw new DraftConflictError("Independent Test must bind its actual preparation process");
        const plan=authorizeRepairPlan(input,input_hash,payload.proposed,payload.artifacts),prior=this.verificationPlan(attempt.attemptId);
        if(prior&&json(prior)!==json(plan))throw new DraftConflictError("Independent preparation cannot be replaced");
        if(!prior)this.db.prepare("INSERT INTO admin_verification_plan VALUES(?,?)").run(attempt.attemptId,json(plan));return {prepared:true};
    });}
    private planHash(plan:unknown){return createHash("sha256").update(json(preparedRepairPlanSchema.parse(plan))).digest("hex");}
    private preparationSource(caseId:string,inputHash:string){
        for(const row of this.db.prepare("SELECT payload FROM admin_attempt WHERE case_id=? ORDER BY rowid DESC").all(caseId)){
            const attempt=attemptSchema.parse(JSON.parse(String(row.payload))),plan=this.verificationPlan(attempt.attemptId);
            if(attempt.role==="verification"&&attempt.status==="completed"&&attempt.finishedAt!==null&&plan?.inputHash===inputHash)return {attemptId:attempt.attemptId,plan,hash:this.planHash(plan)};
        }
        throw new DraftConflictError("Native verification has no physically settled independent plan");
    }
    private executionBasis(claim:AdminClaim){
        return this.executionBasisFor(this.current(claim));
    }
    private executionBasisFor(attempt:Attempt){
        const binding=attempt.verification;
        if(attempt.role!=="verification-execution"||!binding?.sourcePreparationAttemptId||!binding.planHash)throw new DraftConflictError("Invocation is not native independent check execution");
        const producer=this.read(binding.sourcePreparationAttemptId),source=this.verificationInput(binding.sourceRepairAttemptId),plan=this.verificationPlan(producer.attemptId);
        if(!source||source.hash!==binding.inputHash||producer.role!=="verification"||producer.caseId!==attempt.caseId||producer.status!=="completed"||producer.finishedAt===null||!plan||this.planHash(plan)!==binding.planHash||plan.inputHash!==source.hash)throw new DraftConflictError("Independent plan identity or physical source changed");
        const validated=authorizeRepairPlan(source.input,source.hash,{reproduction:plan.reproduction,acceptanceChecks:plan.acceptanceChecks},plan.artifacts);
        if(json(validated)!==json(plan))throw new DraftConflictError("Independent plan no longer matches the original input");
        return {attempt,source,plan,planHash:binding.planHash,sourcePreparationAttemptId:binding.sourcePreparationAttemptId};
    }
    private executionChecks(attemptId:string){return this.db.prepare("SELECT payload FROM admin_verification_check WHERE attempt_id=? ORDER BY ordinal").all(attemptId).map(row=>independentCheckSchema.parse(JSON.parse(String(row.payload))));}
    startIndependentCheck(claim:AdminClaim,ordinal:number){return this.transaction(()=>{
        const basis=this.executionBasis(claim);this.verificationCurrent(claim,true);
        if(basis.attempt.status!=="running"||!basis.attempt.pid||!basis.attempt.startMarker)throw new DraftConflictError("Native worker identity must bind before any check");
        const checks=this.executionChecks(claim.attemptId),step=independentCheckSteps(basis.plan)[ordinal];
        if(!step||ordinal!==checks.length||checks.some(check=>!independentCheckPassed(check,basis.plan.expectedVersion)))throw new DraftConflictError("Independent checks cannot be skipped, replayed or continue after failure");
        const check=independentCheckSchema.parse({ordinal,...step,result:null});
        this.db.prepare("INSERT INTO admin_verification_check VALUES(?,?,?)").run(claim.attemptId,ordinal,json(check));return check;
    });}
    finishIndependentCheck(claim:AdminClaim,raw:unknown){const payload=z.strictObject({ordinal:z.number().int().nonnegative(),result:independentCheckResultSchema}).parse(raw);return this.transaction(()=>{
        const {attempt}=this.executionBasis(claim);
        if(attempt.status!=="running"||attempt.pid!==payload.result.workerPID||attempt.startMarker!==payload.result.workerMarker)throw new DraftConflictError("Check result belongs to another native worker");
        const row=this.db.prepare("SELECT payload FROM admin_verification_check WHERE attempt_id=? AND ordinal=?").get(claim.attemptId,payload.ordinal);
        if(!row)throw new DraftConflictError("Independent check was not durably started");
        const check=independentCheckSchema.parse(JSON.parse(String(row.payload)));
        if(check.result){if(json(check.result)!==json(payload.result))throw new DraftConflictError("Independent check result cannot be replaced");return {recorded:true};}
        this.db.prepare("UPDATE admin_verification_check SET payload=? WHERE attempt_id=? AND ordinal=?").run(json({...check,result:payload.result}),claim.attemptId,payload.ordinal);return {recorded:true};
    });}
    compileIndependentVerification(claim:AdminClaim,workerExitConfirmed:boolean,nativeScopeConfirmed:boolean,reason?:string){return this.transaction(()=>{
        const basis=this.executionBasis(claim);let scope=false;try{this.verificationCurrent(claim,true);scope=true;}catch{ /* Negative evidence must survive source changes. */ }
        const receipt=compileIndependentReceipt({attemptId:claim.attemptId,sourcePreparationAttemptId:basis.sourcePreparationAttemptId,inputHash:basis.source.hash,planHash:basis.planHash,plan:basis.plan,checks:this.executionChecks(claim.attemptId),scopeConfirmed:scope,workerExitConfirmed,nativeScopeConfirmed,reason});
        const prior=this.independentVerificationReceipt(claim.attemptId);
        if(prior&&json(prior)!==json(receipt))throw new DraftConflictError("Independent verification receipt cannot be replaced");
        if(!prior)this.db.prepare("INSERT INTO admin_verification_receipt VALUES(?,?)").run(claim.attemptId,json(receipt));return receipt;
    });}
    independentVerificationReceipt(attemptId:string){const row=this.db.prepare("SELECT payload FROM admin_verification_receipt WHERE attempt_id=?").get(attemptId);return row?independentReceiptSchema.parse(JSON.parse(String(row.payload))):null;}
    readIndependentVerificationReceipt(authority:AdminAuthority,attemptId:string){this.requireAuthority(authority);return this.independentVerificationReceipt(text.parse(attemptId));}
    repairWrite(attemptId:string){
        const row=this.db.prepare("SELECT payload FROM admin_repair_write WHERE attempt_id=?").get(attemptId);
        if(!row)return null;
        const grant=writeGrantSchema.parse(JSON.parse(String(row.payload)));
        if(grant.body.claim.attemptId!==attemptId||nativeReceiptHash(grant.body)!==grant.hash)throw new DraftConflictError("Native repair write receipt changed");
        return grant;
    }
    repairCandidates(attemptId:string){return this.db.prepare("SELECT payload FROM admin_repair_candidate WHERE attempt_id=? ORDER BY rowid").all(attemptId).map(row=>{
        const candidate=candidateSchema.parse(JSON.parse(String(row.payload)));
        if(nativeReceiptHash(candidate.body)!==candidate.hash||candidate.body.evidenceKey!==`native-candidate/${candidate.body.key}`)throw new DraftConflictError("Native repair candidate receipt changed");
        return candidate;
    });}
    private repairWriteContext(claim:AdminClaim){
        const attempt=this.current(claim,true),request=this.takeover(claim.attemptId),progress=this.progress(claim.attemptId);
        if(attempt.role!=="investigation"||attempt.submission||attempt.status!=="running"||!attempt.pid||!attempt.startMarker||attempt.processGroupId!==attempt.pid)throw new DraftConflictError("Repair writes require the current bound investigator before submission");
        if(!request?.inspection||progress?.phase!=="owned"||!progress.workspace_version||!progress.workspace_root||progress.workspace_root!==request.inspection.registered_repository_path||progress.source_attempt_id!==request.source_attempt_id||progress.snapshot_hash!==request.snapshot_hash)throw new DraftConflictError("Repair writes require fresh owned source and content");
        const observations=this.originalObservations(attempt.caseId);
        if(observations.some(row=>row.workspaceId!==request.workspace_id||row.issueId!==request.issue_id))throw new DraftConflictError("Repair originals changed native scope");
        return {attempt,request,progress,originalObservationIds:observations.map(row=>String(row.observationId)).sort()};
    }
    private assertWriteBinding(claim:AdminClaim){
        const current=this.repairWriteContext(claim),grant=this.repairWrite(claim.attemptId);
        if(!grant||json(grant.body.claim)!==json(claim)||grant.body.intentRevision!==current.attempt.intentRevision||grant.body.pid!==current.attempt.pid||grant.body.marker!==current.attempt.startMarker||json(grant.body.source)!==json(current.request.inspection)||grant.body.targetsHash!==current.progress.targets_hash||grant.body.workspaceRoot!==current.progress.workspace_root||json(grant.body.originalObservationIds)!==json(current.originalObservationIds))throw new DraftConflictError("Repair write authorization changed; start a new repair attempt");
        return {...current,grant};
    }
    authorizeRepairWrite(claim:AdminClaim,reason:string){return this.transaction(()=>{
        const current=this.repairWriteContext(claim),prior=this.repairWrite(claim.attemptId);
        reason=text.max(16000).parse(reason);
        if(prior){this.assertWriteBinding(claim);if(prior.body.reason!==reason)throw new DraftConflictError("Repair write reason cannot be replaced");return prior;}
        const body=writeGrantBody.parse({claim,intentRevision:current.attempt.intentRevision,pid:current.attempt.pid,marker:current.attempt.startMarker,source:current.request.inspection,targetsHash:current.progress.targets_hash,workspaceRoot:current.progress.workspace_root,baselineVersion:current.progress.workspace_version,originalObservationIds:current.originalObservationIds,reason});
        const grant={body,hash:nativeReceiptHash(body)};
        this.db.prepare("INSERT INTO admin_repair_write VALUES(?,?)").run(claim.attemptId,json(grant));return grant;
    });}
    recordRepairCandidate(claim:AdminClaim,key:string){return this.transaction(()=>{
        key=candidateKey.parse(key);const {grant,progress}=this.assertWriteBinding(claim);
        const body=candidateBody.parse({grantHash:grant.hash,key,evidenceKey:`native-candidate/${key}`,version:progress.workspace_version}),candidate={body,hash:nativeReceiptHash(body)};
        const previous=this.repairCandidates(claim.attemptId),prior=previous.find(row=>row.body.key===key);
        if(prior&&json(prior)!==json(candidate))throw new DraftConflictError("Repair candidate key cannot be replaced");
        if(!prior){if(previous.length>=100)throw new DraftConflictError("Repair attempt exceeds 100 retained candidates");this.db.prepare("INSERT INTO admin_repair_candidate VALUES(?,?,?)").run(claim.attemptId,key,json(candidate));
            this.db.prepare("INSERT INTO admin_evidence VALUES(?,?,?,?)").run(claim.attemptId,body.evidenceKey,"change",json({nativeRepairCandidate:candidate,writeAuthorization:grant}));}
        return candidate;
    });}
    pendingHandoffs(authority:AdminAuthority){if(this.requireAuthority(authority).desired_intent!=="running")return [];return this.db.prepare("SELECT case_id FROM admin_case WHERE status='verified' AND current_attempt_id IS NULL ORDER BY updated_at,case_id").all().map(row=>({case_id:String(row.case_id)}));}
    handoffContext(authority:AdminAuthority,caseId:string){
        const control=this.requireAuthority(authority);
        if(control.desired_intent!=="running")throw new DraftConflictError("Verified handoff requires current running intent");
        const repair=this.db.prepare("SELECT status,current_attempt_id FROM admin_case WHERE case_id=?").get(caseId);
        if(repair?.status!=="verified"||repair.current_attempt_id!==null)throw new DraftConflictError("Case has no settled verified handoff");
        const row=this.db.prepare("SELECT payload FROM admin_attempt WHERE case_id=? ORDER BY rowid DESC LIMIT 1").get(caseId);
        if(!row)throw new DraftConflictError("Verified handoff has no execution source");
        const attempt=attemptSchema.parse(JSON.parse(String(row.payload))),basis=this.executionBasisFor(attempt),receipt=this.independentVerificationReceipt(attempt.attemptId),progress=this.progress(attempt.attemptId),request=this.takeover(attempt.attemptId);
        if(attempt.status!=="completed"||attempt.finishedAt===null||!attempt.pid||!attempt.startMarker||!receipt?.passed||!receipt.workerExitConfirmed||!receipt.nativeScopeConfirmed||!request?.inspection||progress?.phase!=="owned"||progress.workspace_version!==basis.source.input.expectedVersion||progress.targets_hash!==basis.source.input.workspaceBinding.targetsHash||progress.workspace_root!==basis.source.input.workspaceBinding.workspaceRoot)throw new DraftConflictError("Handoff requires settled native verification and its exact owned source");
        const sourceRepair=this.read(basis.source.input.sourceRepairAttemptId);
        if(sourceRepair.role!=="investigation"||sourceRepair.status!=="completed"||sourceRepair.finishedAt===null||sourceRepair.submission?.outcome!=="verification-requested"||request.claim.attemptId!==attempt.attemptId)throw new DraftConflictError("Handoff repair source is not physically settled");
        const ids=this.originalObservations(caseId).map(row=>String(row.observationId)).sort();
        if(json(ids)!==json(basis.source.input.originalObservations.map(row=>row.observationId).sort()))throw new DraftConflictError("Handoff original coverage changed");
        const checks=this.executionChecks(attempt.attemptId);
        if(checks.some(check=>check.result?.workerPID!==attempt.pid||check.result?.workerMarker!==attempt.startMarker))throw new DraftConflictError("Handoff physical check identity changed");
        const compiled=compileIndependentReceipt({attemptId:attempt.attemptId,sourcePreparationAttemptId:basis.sourcePreparationAttemptId,inputHash:basis.source.hash,planHash:basis.planHash,plan:basis.plan,checks,scopeConfirmed:true,workerExitConfirmed:true,nativeScopeConfirmed:true});
        if(!compiled.passed||json(compiled)!==json(receipt))throw new DraftConflictError("Handoff verification receipt no longer compiles");
        const target=repairHandoffTargetSchema.parse({caseId,verificationAttemptId:attempt.attemptId,sourceRepairAttemptId:basis.source.input.sourceRepairAttemptId,sourcePreparationAttemptId:basis.sourcePreparationAttemptId,receiptHash:handoffHash(receipt),inputHash:basis.source.hash,nativeCandidateHash:basis.source.nativeCandidateHash,planHash:basis.planHash,expectedVersion:basis.source.input.expectedVersion,workspaceBinding:basis.source.input.workspaceBinding,originalObservationIds:ids,observationId:request.observation_id,snapshotHash:request.snapshot_hash,sourceReceiptHash:request.inspection.receipt_hash});
        const targetHash=handoffHash(target),saved=this.db.prepare("SELECT payload FROM admin_handoff_preparation WHERE case_id=? AND verification_attempt_id=?").get(caseId,attempt.attemptId),preparation=saved?handoffPreparationSchema.parse(JSON.parse(String(saved.payload))):null;
        if(preparation&&preparation.target_hash!==targetHash)throw new DraftConflictError("Saved handoff preparation changed proof identity");
        const context={authority,intent_revision:attempt.intentRevision,current_intent_revision:control.intent_revision,request,target,target_hash:targetHash,preparation};
        const reserved=this.db.prepare("SELECT payload FROM admin_handoff_reservation WHERE case_id=? AND verification_attempt_id=?").get(caseId,attempt.attemptId),reservation=reserved?handoffReservationSchema.parse(JSON.parse(String(reserved.payload))):null;
        if(reservation)this.validateHandoffReservation(reservation,context);
        const staged=this.db.prepare("SELECT payload FROM admin_handoff_application WHERE case_id=? AND verification_attempt_id=?").get(caseId,attempt.attemptId),application=staged?handoffApplicationSchema.parse(JSON.parse(String(staged.payload))):null;
        if(application)this.validateHandoffApplication(application,reservation,preparation);
        return {...context,reservation,application};
    }
    recordHandoffPreparation(authority:AdminAuthority,caseId:string,raw:unknown){const prepared=handoffPreparationSchema.parse(raw);return this.transaction(()=>{
        const context=this.handoffContext(authority,caseId);
        if(prepared.target_hash!==context.target_hash||prepared.continuation.workspace_id!==context.target.workspaceBinding.workspaceId||prepared.continuation.issue_id!==context.target.workspaceBinding.issueId)throw new DraftConflictError("Native handoff preparation belongs to another verified source");
        const row=this.db.prepare("SELECT payload FROM admin_handoff_preparation WHERE case_id=? AND verification_attempt_id=?").get(caseId,context.target.verificationAttemptId);
        if(row&&String(row.payload)!==json(prepared))throw new DraftConflictError("Native handoff preparation cannot be replaced");
        if(!row)this.db.prepare("INSERT INTO admin_handoff_preparation VALUES(?,?,?)").run(caseId,context.target.verificationAttemptId,json(prepared));return prepared;
    });}
    private validateHandoffReservation(value:HandoffReservation,context:{target:RepairHandoffTarget;target_hash:string;preparation:z.infer<typeof handoffPreparationSchema>|null;request:z.infer<typeof takeoverSchema>;intent_revision:number}){
        const t=context.target,p=context.preparation,r=context.request,f=value.fence,b=t.workspaceBinding;
        if(!p||value.case_id!==t.caseId||value.verification_attempt_id!==t.verificationAttemptId||value.target_hash!==context.target_hash||value.preparation_hash!==p.hash||value.project_id!==b.projectId||value.expected_version!==t.expectedVersion||json(value.continuation)!==json(p.continuation)||
            f.attempt_id!==r.claim.attemptId||f.generation!==r.claim.generation||f.owner_id!==r.claim.authority.ownerId||f.supervision_token!==r.claim.authority.token||f.intent_revision!==context.intent_revision||f.observation_id!==t.observationId||f.source_attempt_id!==b.sourceAttemptId||f.source_revision!==p.continuation.expected_revision||f.snapshot_hash!==t.snapshotHash||f.workspace_path!==b.workspaceRoot||f.targets_hash!==b.targetsHash)throw new DraftConflictError("Native reservation differs from the verified source or acknowledged proposal");
    }
    recordHandoffReservation(authority:AdminAuthority,caseId:string,raw:unknown){const value=handoffReservationSchema.parse(raw);return this.transaction(()=>{
        const context=this.handoffContext(authority,caseId);this.validateHandoffReservation(value,context);
        const row=this.db.prepare("SELECT payload FROM admin_handoff_reservation WHERE case_id=? AND verification_attempt_id=?").get(caseId,context.target.verificationAttemptId);
        if(row&&String(row.payload)!==json(value))throw new DraftConflictError("Native handoff reservation cannot be replaced");
        if(!row)this.db.prepare("INSERT INTO admin_handoff_reservation VALUES(?,?,?)").run(caseId,context.target.verificationAttemptId,json(value));return value;
    });}
    private validateHandoffApplication(value:HandoffApplication,reservation:HandoffReservation|null,preparation:z.infer<typeof handoffPreparationSchema>|null){
        if(!reservation||!preparation||value.target_hash!==reservation.target_hash||value.preparation_hash!==reservation.preparation_hash||value.reservation_hash!==reservation.hash||value.expected_version!==reservation.expected_version||json(value.continuation)!==json(reservation.continuation)||value.draft_id!==preparation.draft_id||(value.root_kind==="direct")!==(preparation.kind==="direct"))throw new DraftConflictError("Applied business handoff differs from its acknowledged native reservation");
    }
    recordHandoffApplication(authority:AdminAuthority,caseId:string,raw:unknown){const value=handoffApplicationSchema.parse(raw);return this.transaction(()=>{
        const context=this.handoffContext(authority,caseId);this.validateHandoffApplication(value,context.reservation,context.preparation);
        const row=this.db.prepare("SELECT payload FROM admin_handoff_application WHERE case_id=? AND verification_attempt_id=?").get(caseId,context.target.verificationAttemptId);
        if(row&&String(row.payload)!==json(value))throw new DraftConflictError("Applied business handoff cannot be replaced");
        if(!row)this.db.prepare("INSERT INTO admin_handoff_application VALUES(?,?,?)").run(caseId,context.target.verificationAttemptId,json(value));return value;
    });}
    private originalObservations(caseId: string) {
        return this.db.prepare("SELECT payload FROM admin_observation WHERE case_id=? AND origin<>'admin' ORDER BY rowid").all(caseId).map(row => JSON.parse(String(row.payload)));
    }
    private validateVerificationSubmission(attempt: Attempt, submission: Extract<z.infer<typeof adminSubmissionSchema>, {outcome:"verification-requested"}>) {
        const request = this.takeover(attempt.attemptId), progress = this.progress(attempt.attemptId);
        if (!request?.inspection || progress?.phase !== "owned" || !progress.workspace_version || progress.workspace_version !== submission.repairVersion) throw new DraftConflictError("Independent verification requires owned workspace takeover and the actual repair version");
        const observations = this.originalObservations(attempt.caseId);
        if (observations.some(row => row.workspaceId !== request.workspace_id || row.issueId !== request.issue_id)) throw new DraftConflictError("Original verification observations changed native scope");
        const ids = observations.map(row => String(row.observationId));
        if (json([...ids].sort()) !== json([...submission.originalObservationIds].sort())) throw new DraftConflictError("Independent verification must preserve every original observation");
        originalRepairTargets(observations);
        if (new Set(submission.repairEvidenceKeys).size !== submission.repairEvidenceKeys.length || submission.repairEvidenceKeys.some(key => !this.db.prepare("SELECT 1 FROM admin_evidence WHERE attempt_id=? AND receipt_key=?").get(attempt.attemptId, key))) throw new DraftConflictError("Repair evidence must reference this attempt's saved immutable facts");
        const grant=this.repairWrite(attempt.attemptId),candidate=this.repairCandidates(attempt.attemptId).find(row=>row.body.grantHash===grant?.hash&&row.body.version===submission.repairVersion&&submission.repairEvidenceKeys.includes(row.body.evidenceKey));
        if(!grant||!candidate||grant.body.targetsHash!==progress.targets_hash||grant.body.workspaceRoot!==progress.workspace_root||json(grant.body.source)!==json(request.inspection)||json(grant.body.originalObservationIds)!==json(ids.sort()))throw new DraftConflictError("Independent verification requires a native repair candidate from this authorized cohort");
        return {request, progress, observations,candidate};
    }
    readVerificationInput(authority: AdminAuthority, attemptId: string) { this.requireAuthority(authority); return this.verificationInput(text.parse(attemptId)); }
    verificationInput(attemptId: string) {
        const row = this.db.prepare("SELECT payload FROM admin_verification_input WHERE attempt_id=?").get(attemptId);
        if (!row) return null;
        const value = z.strictObject({input:repairVerificationInputSchema,hash:text,nativeCandidateHash:nativeHash}).parse(JSON.parse(String(row.payload)));
        if (value.input.sourceRepairAttemptId !== attemptId || json(value.input.targets) !== json(originalRepairTargets(value.input.originalObservations)) || repairVerificationInputHash(value.input) !== value.hash) throw new DraftConflictError("Frozen independent verification input changed");
        const candidate=this.repairCandidates(attemptId).find(row=>row.hash===value.nativeCandidateHash),grant=this.repairWrite(attemptId);
        if(!candidate||candidate.body.version!==value.input.expectedVersion||candidate.body.grantHash!==grant?.hash)throw new DraftConflictError("Frozen verification lost its native candidate identity");
        return value;
    }
    prepareVerification(claim: AdminClaim) {
        return this.transaction(() => {
            const attempt = this.current(claim, true);
            if (attempt.submission?.outcome !== "verification-requested") throw new DraftConflictError("No submitted verification request");
            const {request, progress, observations,candidate} = this.validateVerificationSubmission(attempt, attempt.submission), inspected = request.inspection!;
            const input = repairVerificationInputSchema.parse({version:1,caseId:attempt.caseId,sourceRepairAttemptId:attempt.attemptId,generation:attempt.generation,ownerId:attempt.ownerId,supervisionToken:attempt.supervisionToken,intentRevision:attempt.intentRevision,expectedVersion:progress.workspace_version,
                workspaceBinding:{workspaceId:request.workspace_id,issueId:request.issue_id,projectId:inspected.project_id,runtimeId:inspected.runtime_id,workspaceRoot:progress.workspace_root,executionPath:inspected.execution_repository_path,mode:inspected.mode,sourceAttemptId:request.source_attempt_id,snapshotHash:request.snapshot_hash,targetsHash:progress.targets_hash},
                originalObservations:observations,targets:originalRepairTargets(observations)});
            const value = {input,hash:repairVerificationInputHash(input),nativeCandidateHash:candidate.hash}, prior = this.verificationInput(attempt.attemptId);
            if (prior && json(prior) !== json(value)) throw new DraftConflictError("Frozen independent verification input cannot be replaced");
            if (!prior) this.db.prepare("INSERT INTO admin_verification_input VALUES(?,?)").run(attempt.attemptId,json(value));
            return {prepared:true,input_hash:value.hash,target_count:input.targets.length};
        });
    }
    private takeover(attemptId:string) {const row=this.db.prepare("SELECT payload FROM admin_takeover WHERE attempt_id=?").get(attemptId);return row ? takeoverSchema.parse(JSON.parse(String(row.payload))) : null;}
    pendingTakeovers(authority:AdminAuthority) {
        this.requireAuthority(authority);
        return this.active().flatMap(attempt=>{const request=this.takeover(attempt.attemptId);if(!request)return [];try{const current=this.current(adminClaimSchema.parse(request.claim));if(current.submission)return [];return [request];}catch{return [];}});
    }
    currentTakeover(claim:AdminClaim) {
        const attempt=this.current(claim,true),request=this.takeover(claim.attemptId);
        if((attempt.submission && attempt.submission.outcome!=="verification-requested") || !request || request.phase!=="source-inspected")throw new DraftConflictError("Takeover source is not inspected or invocation already submitted");
        return {request,attempt,intent_revision:attempt.intentRevision};
    }
    private progress(attemptId:string){const row=this.db.prepare("SELECT payload FROM admin_takeover_progress WHERE attempt_id=?").get(attemptId);return row ? takeoverProgressSchema.parse(JSON.parse(String(row.payload))) : null;}
    recordTakeoverProgress(claim:AdminClaim,input:unknown){
        const progress=takeoverProgressSchema.parse(input);
        return this.transaction(()=>{const {request}=this.currentTakeover(claim);
            if(progress.source_attempt_id!==request.source_attempt_id || progress.snapshot_hash!==request.snapshot_hash || (progress.phase==="owned" ? progress.workspace_root!==request.inspection?.registered_repository_path || progress.unknown_tasks!==0 || progress.unfinished_controllers!==0 : progress.workspace_root!==null || progress.workspace_version!==null))throw new DraftConflictError("Physical takeover progress does not match the original source");
            this.db.prepare("INSERT INTO admin_takeover_progress VALUES(?,?) ON CONFLICT(attempt_id) DO UPDATE SET payload=excluded.payload").run(claim.attemptId,json(progress));return {recorded:true};
        });
    }
    predecessorStopped(claim:AdminClaim,attemptId:string) {
        this.currentTakeover(claim);
        const prior=this.read(text.parse(attemptId));
        if(prior.caseId!==claim.caseId || prior.generation>=claim.generation)throw new DraftConflictError("Takeover predecessor belongs to another Case or generation");
        return {stopped:!['launching','running'].includes(prior.status) && prior.finishedAt!==null};
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
    }
        if(attempt.role==="verification-execution"){
            let passed=false;
            try{const basis=this.executionBasis(claim);this.verificationCurrent(claim,true);const receipt=this.independentVerificationReceipt(claim.attemptId);const compiled=compileIndependentReceipt({attemptId:claim.attemptId,sourcePreparationAttemptId:basis.sourcePreparationAttemptId,inputHash:basis.source.hash,planHash:basis.planHash,plan:basis.plan,checks:this.executionChecks(claim.attemptId),scopeConfirmed:true,workerExitConfirmed:value.exit_confirmed,nativeScopeConfirmed:true});passed=!!receipt?.passed&&compiled.passed&&json(receipt)===json(compiled);}catch{ /* A saved partial receipt cannot authorize completion. */ }
            attempt.status=passed?"completed":"failed";attempt.finishedAt=this.now();attempt.lastError=value.reason;this.save(attempt);
            this.db.prepare("UPDATE admin_case SET current_attempt_id=NULL,status=?,updated_at=? WHERE case_id=?").run(passed?"verified":"queued",this.now(),attempt.caseId);return {settled:true};
        }
        if(attempt.role==="verification"){
            let prepared=false;
            try{this.verificationCurrent(claim,true);prepared=this.verificationPlan(attempt.attemptId)!==null;}catch{ /* Retain the failed plan and original input. */ }
            attempt.status=prepared?"completed":"failed";attempt.finishedAt=this.now();attempt.lastError=value.reason;this.save(attempt);
            this.db.prepare("UPDATE admin_case SET current_attempt_id=NULL,status=?,updated_at=? WHERE case_id=?").run(prepared?"verification-prepared":"queued",this.now(),attempt.caseId);
            return {settled:true};
        }
        const frozen = this.verificationInput(attempt.attemptId);
        let prepared = false;
        if (attempt.submission?.outcome === "verification-requested" && frozen) {
            try {
                const {progress} = this.validateVerificationSubmission(attempt, attempt.submission);
                prepared = frozen.input.expectedVersion === progress.workspace_version && frozen.input.workspaceBinding.targetsHash === progress.targets_hash;
            } catch { /* Preserve the prepared input as history; changed scope cannot enter verification. */ }
        }
        attempt.status = prepared ? "completed" : "failed"; attempt.finishedAt = this.now();
        attempt.lastError = attempt.submission?.outcome === "verification-requested" && !prepared ? "Verification request has no current host-prepared original input" : attempt.submission?.summary ?? value.reason;
        this.save(attempt);
        this.db.prepare("UPDATE admin_case SET current_attempt_id=NULL,status=?,updated_at=? WHERE case_id=?").run(prepared ? "verifying" : "queued", this.now(), attempt.caseId);
        return { settled: true };
    }); }
    retire(authority: AdminAuthority, input: unknown) { const value = z.strictObject({ attempt_id: text, exit_confirmed: z.boolean(), pid: z.number().int().nonnegative(), marker: z.string(), owned_launch: z.boolean().optional().default(false), reason: text }).parse(input); return this.transaction(() => { const control = this.requireAuthority(authority), attempt = this.read(value.attempt_id); if (!value.exit_confirmed)
        return { retired: false }; if (!["waiting", "launching", "running"].includes(attempt.status))
        return { retired: true }; if (attempt.pid === null ? !(value.owned_launch && attempt.ownerId === authority.ownerId && attempt.supervisionToken === authority.token) : attempt.pid !== value.pid || attempt.startMarker !== value.marker)
        throw new DraftConflictError("Exit proof belongs to another process identity"); const repair = this.db.prepare("SELECT current_attempt_id FROM admin_case WHERE case_id=?").get(attempt.caseId); if (repair?.current_attempt_id !== attempt.attemptId)
        throw new DraftConflictError("Exit proof belongs to another Case generation"); attempt.status = "interrupted"; attempt.finishedAt = this.now(); attempt.lastError = value.reason; attempt.interruptionCause = control.desired_intent === "stopped" ? "user-stop" : "host-loss"; this.save(attempt); this.db.prepare("UPDATE admin_case SET current_attempt_id=NULL,status='queued',updated_at=? WHERE case_id=?").run(this.now(), attempt.caseId); return { retired: true }; }); }
}
