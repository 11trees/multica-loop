import { AdminExecutionStore, initializeAdminExecution, adminClaimSchema } from "./admin-execution";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DraftConflictError } from "./runtime";

const text = z.string().trim().min(1);
export const repairObservationSchema = z.strictObject({
  observationId: text.max(500), workspaceId: z.uuid(), issueId: z.uuid(), scope: z.enum(["execution", "work-item", "run", "runtime"]),
  scopeKey: text.max(1000), fingerprint: text.max(1000), sourceVersion: text.max(500), summary: text.max(16000),
  evidence: z.record(z.string(), z.unknown()), origin: z.enum(["business", "runtime", "admin"]), repairCaseId: text.optional(),
});
export const adminAuthoritySchema = z.strictObject({ ownerId: text, token: z.number().int().positive() });
export type RepairObservation = z.infer<typeof repairObservationSchema>;
export type AdminAuthority = z.infer<typeof adminAuthoritySchema>;
type Case = { caseId: string; workspaceId: string; scope: string; scopeKey: string; originalVersion: string; originalSummary: string; status: string; generation: number; currentAttemptId: string | null };
type Control = { owner_id: string | null; fencing_token: number; expires_at: number; execution_supported:number; desired_intent: "stopped" | "running"; intent_revision: number };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Independent management storage; never opens or migrates the business DB. */
export class AdminStore {
  private readonly db: DatabaseSync;
  readonly execution:AdminExecutionStore;
  constructor(filename: string, private readonly now: () => number = Date.now) {
    if (!isAbsolute(filename)) throw new Error("Admin storage requires an independent absolute path");
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const canonical = existsSync(filename) ? realpathSync(filename) : resolve(filename);
    this.db = new DatabaseSync(canonical);
    try {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (tables.some(table => /^(engineering_|requirement_|business_contract$|direct_contract$|chain_drafts$)/.test(String(table.name))) || tables.length && !tables.some(table => table.name === "admin_control")) throw new Error("Admin storage cannot reuse a business or unrelated database");
      const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
      if (version > 10) throw new Error("Admin database version is newer than this worker");
      this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS admin_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          desired_intent TEXT NOT NULL DEFAULT 'stopped',intent_revision INTEGER NOT NULL DEFAULT 0,
          owner_id TEXT,fencing_token INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO admin_control(singleton) VALUES(1);
        CREATE TABLE IF NOT EXISTS admin_case(case_id TEXT PRIMARY KEY,dedupe_key TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,
          scope TEXT NOT NULL,scope_key TEXT NOT NULL,original_version TEXT NOT NULL,original_summary TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',generation INTEGER NOT NULL DEFAULT 0,current_attempt_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS admin_observation(observation_id TEXT PRIMARY KEY,case_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
          issue_id TEXT NOT NULL,origin TEXT NOT NULL,observation_hash TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS admin_observation_issue ON admin_observation(workspace_id,issue_id);
        `);
      const lockedVersion=Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
      if(lockedVersion>10)throw new Error("Admin database version is newer than this worker");
      initializeAdminExecution(this.db,lockedVersion);
      this.db.exec("PRAGMA user_version=10; COMMIT");
      this.execution=new AdminExecutionStore(this.db,this.now,value=>this.requireSupervisor(value));
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  control() { return this.db.prepare("SELECT * FROM admin_control WHERE singleton=1").get() as unknown as Control; }
  acquireSupervisor(ownerId: string, leaseMs = 30000, executionSupported=false): AdminAuthority | null {
    text.parse(ownerId);
    if (!Number.isFinite(leaseMs) || leaseMs < 1000) throw new Error("Invalid Admin supervision lease");
    return this.transaction(() => {
      const control = this.control(), now = this.now();
      if (control.owner_id !== ownerId && control.expires_at > now) return null;
      const token = control.owner_id === ownerId && control.expires_at > now ? control.fencing_token : control.fencing_token + 1;
      this.db.prepare("UPDATE admin_control SET owner_id=?,fencing_token=?,expires_at=?,execution_supported=? WHERE singleton=1").run(ownerId, token, now + leaseMs,executionSupported?1:0);
      return { ownerId, token };
    });
  }
  renewSupervisor(authority: AdminAuthority, leaseMs = 30000) {
    adminAuthoritySchema.parse(authority);
    if (!Number.isFinite(leaseMs) || leaseMs < 1000) throw new Error("Invalid Admin supervision lease");
    return this.db.prepare("UPDATE admin_control SET expires_at=? WHERE singleton=1 AND owner_id=? AND fencing_token=? AND expires_at>?")
      .run(this.now() + leaseMs, authority.ownerId, authority.token, this.now()).changes === 1;
  }
  releaseSupervisor(authority: AdminAuthority) {
    adminAuthoritySchema.parse(authority);
    const changed = this.db.prepare("UPDATE admin_control SET owner_id=NULL,expires_at=0 WHERE singleton=1 AND owner_id=? AND fencing_token=?").run(authority.ownerId, authority.token);
    return { released: changed.changes === 1 };
  }
  private requireSupervisor(authority: AdminAuthority) {
    const control = this.control();
    if (control.owner_id !== authority.ownerId || control.fencing_token !== authority.token || control.expires_at <= this.now()) throw new DraftConflictError("Admin supervision authority expired or changed");
    return control;
  }
  private getCase(caseId: string): Case | undefined {
    return this.db.prepare(`SELECT case_id AS caseId,workspace_id AS workspaceId,scope,scope_key AS scopeKey,original_version AS originalVersion,
      original_summary AS originalSummary,status,generation,current_attempt_id AS currentAttemptId FROM admin_case WHERE case_id=?`).get(caseId) as unknown as Case | undefined;
  }
  observe(authority: AdminAuthority, input: unknown) {
    const observation = repairObservationSchema.parse(input), fingerprint = hash(observation);
    return this.transaction(() => {
      this.requireSupervisor(authority);
      const prior = this.db.prepare("SELECT case_id,observation_hash FROM admin_observation WHERE observation_id=?").get(observation.observationId);
      if (prior) {
        if (prior.observation_hash !== fingerprint) throw new DraftConflictError("Observation identity is already bound to different original evidence");
        return this.getCase(String(prior.case_id))!;
      }
      const key = hash(observation.scope === "work-item" ? [observation.workspaceId, observation.scope, observation.scopeKey] : [observation.workspaceId, observation.scope, observation.scopeKey, observation.fingerprint]);
      let repairCase = this.db.prepare("SELECT case_id FROM admin_case WHERE dedupe_key=?").get(key) as {case_id: string} | undefined;
      if (observation.origin === "admin") {
        const original = observation.repairCaseId ? this.getCase(observation.repairCaseId) : undefined;
        if (!original || original.workspaceId !== observation.workspaceId) throw new DraftConflictError("Admin faults must remain in their original Case; recursive repair is forbidden");
        repairCase = { case_id: original.caseId };
      } else if (observation.repairCaseId) {
        const original = this.getCase(observation.repairCaseId);
        if (!original || original.workspaceId !== observation.workspaceId || original.scope !== observation.scope || original.scopeKey !== observation.scopeKey) throw new DraftConflictError("Observation cannot move to another repair cohort");
        repairCase = { case_id: original.caseId };
      }
      if (!repairCase) {
        repairCase = { case_id: `REPAIR-${randomUUID()}` };
        this.db.prepare("INSERT INTO admin_case(case_id,dedupe_key,workspace_id,scope,scope_key,original_version,original_summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(repairCase.case_id, key, observation.workspaceId, observation.scope, observation.scopeKey, observation.sourceVersion, observation.summary, this.now(), this.now());
      } else {
        this.db.prepare("UPDATE admin_case SET status=CASE WHEN status IN ('closed','verifying','verification-prepared','verified','observing') AND ?<>'admin' THEN 'queued' ELSE status END,updated_at=? WHERE case_id=?")
          .run(observation.origin, this.now(), repairCase.case_id);
      }
      this.db.prepare("INSERT OR IGNORE INTO admin_schedule(case_id) VALUES(?)").run(repairCase.case_id);
      this.db.prepare("INSERT INTO admin_observation VALUES(?,?,?,?,?,?,?,?)").run(observation.observationId, repairCase.case_id, observation.workspaceId, observation.issueId, observation.origin, fingerprint, JSON.stringify(observation), this.now());
      return this.getCase(String(repairCase.case_id))!;
    });
  }
  issue(workspaceId: string, issueId: string) {
    const row = this.db.prepare("SELECT case_id FROM admin_observation WHERE workspace_id=? AND issue_id=? ORDER BY rowid DESC LIMIT 1").get(z.uuid().parse(workspaceId), z.uuid().parse(issueId));
    if (!row) return { recorded: false };
    const repairCase = this.getCase(String(row.case_id))!, control = this.control();
    const count = Number(this.db.prepare("SELECT count(*) AS n FROM admin_observation WHERE case_id=?").get(repairCase.caseId)!.n);
    return { recorded: true, case_id: repairCase.caseId, status: repairCase.status, original_version: repairCase.originalVersion,
      observation_count: count, supervision_active: !!control.owner_id && control.expires_at > this.now(), desired_intent: control.desired_intent,
      runtime_configured:!!this.execution.configuration(),configuration_revision:this.execution.configuration()?.revision??0,
      execution_connected: !!control.owner_id && control.expires_at>this.now() && !!control.execution_supported && !!this.execution.configuration() };
  }
  close() { this.db.close(); }
}

export const adminRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({action:z.literal("state")}),
  z.strictObject({action:z.literal("handoff-pending"),authority:adminAuthoritySchema}),
  z.strictObject({action:z.literal("handoff-context"),authority:adminAuthoritySchema,case_id:text}),
  z.strictObject({action:z.literal("handoff-prepared"),authority:adminAuthoritySchema,case_id:text,payload:z.unknown()}),
  z.strictObject({action:z.literal("handoff-reserved"),authority:adminAuthoritySchema,case_id:text,payload:z.unknown()}),
  z.strictObject({action:z.literal("repair-write-authorize"),claim:adminClaimSchema,reason:text.max(16000)}),
  z.strictObject({action:z.literal("repair-candidate-record"),claim:adminClaimSchema,key:text}),
  z.strictObject({action:z.literal("verification-check-start"),claim:adminClaimSchema,ordinal:z.number().int().nonnegative()}),
  z.strictObject({action:z.literal("verification-check-result"),claim:adminClaimSchema,payload:z.unknown()}),
  z.strictObject({action:z.literal("verification-compile"),claim:adminClaimSchema,worker_exit_confirmed:z.boolean(),native_scope_confirmed:z.boolean(),reason:text.optional()}),
  z.strictObject({action:z.literal("verification-receipt"),authority:adminAuthoritySchema,attempt_id:text}),
  z.strictObject({action:z.literal("verification-current"),claim:adminClaimSchema,require_owned:z.boolean().optional().default(false)}),
  z.strictObject({action:z.literal("verification-launch"),claim:adminClaimSchema}),
  z.strictObject({action:z.literal("verification-wait-cancel"),authority:adminAuthoritySchema,attempt_id:text}),
  z.strictObject({action:z.literal("verification-plan"),claim:adminClaimSchema,payload:z.unknown()}),
  z.strictObject({action:z.literal("verification-plan-read"),authority:adminAuthoritySchema,attempt_id:text}),
  z.strictObject({action:z.literal("takeover-predecessor"),claim:adminClaimSchema,attempt_id:text}),
  z.strictObject({action:z.literal("verification-prepare"),claim:adminClaimSchema}),
  z.strictObject({action:z.literal("verification-input"),authority:adminAuthoritySchema,attempt_id:text}),
  z.strictObject({action:z.literal("takeover-current"),claim:adminClaimSchema}),
  z.strictObject({action:z.literal("takeover-progress"),claim:adminClaimSchema,payload:z.unknown()}),
  z.strictObject({action:z.literal("takeover-pending"),authority:adminAuthoritySchema}),
  z.strictObject({action:z.literal("takeover-inspected"),claim:adminClaimSchema,payload:z.unknown()}),
  z.strictObject({action:z.literal("configuration"),payload:z.unknown().optional()}),
  z.strictObject({action:z.literal("intent"),payload:z.unknown()}),
  z.strictObject({action:z.literal("claim"),authority:adminAuthoritySchema}),
  z.strictObject({action:z.literal("active"),authority:adminAuthoritySchema}),
  z.strictObject({action:z.literal("bind"),claim:adminClaimSchema,payload:z.unknown()}),
  z.strictObject({action:z.literal("command"),claim:adminClaimSchema,payload:z.unknown()}),
  z.strictObject({action:z.literal("finish"),claim:adminClaimSchema,payload:z.unknown()}),
  z.strictObject({action:z.literal("retire"),authority:adminAuthoritySchema,payload:z.unknown()}),
  z.strictObject({ action: z.literal("acquire"), owner_id: text, execution_supported:z.boolean().optional().default(false) }),
  z.strictObject({ action: z.literal("renew"), authority: adminAuthoritySchema }),
  z.strictObject({ action: z.literal("release"), authority: adminAuthoritySchema }),
  z.strictObject({ action: z.literal("observe"), authority: adminAuthoritySchema, observation: repairObservationSchema }),
  z.strictObject({ action: z.literal("issue"), workspace_id: z.uuid(), issue_id: z.uuid() }),
]);
export function invokeAdmin(store: AdminStore, input: unknown) {
  const request = adminRequestSchema.parse(input);
  switch (request.action) {
    case "handoff-pending": return store.execution.pendingHandoffs(request.authority);
    case "handoff-context": return store.execution.handoffContext(request.authority,request.case_id);
    case "handoff-prepared": return store.execution.recordHandoffPreparation(request.authority,request.case_id,request.payload);
    case "handoff-reserved": return store.execution.recordHandoffReservation(request.authority,request.case_id,request.payload);
    case "repair-write-authorize": return store.execution.authorizeRepairWrite(request.claim,request.reason);
    case "repair-candidate-record": return store.execution.recordRepairCandidate(request.claim,request.key);
    case "verification-check-start": return store.execution.startIndependentCheck(request.claim,request.ordinal);
    case "verification-check-result": return store.execution.finishIndependentCheck(request.claim,request.payload);
    case "verification-compile": return store.execution.compileIndependentVerification(request.claim,request.worker_exit_confirmed,request.native_scope_confirmed,request.reason);
    case "verification-receipt": return store.execution.readIndependentVerificationReceipt(request.authority,request.attempt_id);
    case "verification-current": return store.execution.verificationCurrent(request.claim,request.require_owned);
    case "verification-launch": return store.execution.launchVerification(request.claim);
    case "verification-wait-cancel": return store.execution.cancelWaitingVerification(request.authority,request.attempt_id);
    case "verification-plan-read": return store.execution.readVerificationPlan(request.authority,request.attempt_id);
    case "verification-plan": return store.execution.recordVerificationPlan(request.claim,request.payload);
    case "takeover-predecessor": return store.execution.predecessorStopped(request.claim,request.attempt_id);
    case "verification-input": return store.execution.readVerificationInput(request.authority,request.attempt_id);
    case "verification-prepare": return store.execution.prepareVerification(request.claim);
    case "takeover-current": return store.execution.currentTakeover(request.claim);
    case "takeover-progress": return store.execution.recordTakeoverProgress(request.claim,request.payload);
    case "takeover-pending": return store.execution.pendingTakeovers(request.authority);
    case "takeover-inspected": return store.execution.inspectTakeover(request.claim,request.payload);
    case "state": return {control:store.control(),runtime:store.execution.configuration(),active:store.execution.active()};
    case "configuration": return request.payload===undefined ? store.execution.configuration() : store.execution.configure(request.payload);
    case "intent": return store.execution.setIntent(request.payload);
    case "claim": return store.execution.claim(request.authority);
    case "active": return store.execution.active();
    case "bind": return store.execution.bind(request.claim,request.payload);
    case "command": return store.execution.command(request.claim,request.payload);
    case "finish": return store.execution.finish(request.claim,request.payload);
    case "retire": return store.execution.retire(request.authority,request.payload);
    case "acquire": return { authority: store.acquireSupervisor(request.owner_id,30000,request.execution_supported) };
    case "renew": return { renewed: store.renewSupervisor(request.authority) };
    case "release": return store.releaseSupervisor(request.authority);
    case "observe": return store.observe(request.authority, request.observation);
    case "issue": return store.issue(request.workspace_id, request.issue_id);
  }
}
