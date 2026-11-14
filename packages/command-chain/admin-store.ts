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
type Control = { owner_id: string | null; fencing_token: number; expires_at: number; desired_intent: "stopped" | "running"; intent_revision: number };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Independent management storage; never opens or migrates the business DB. */
export class AdminStore {
  private readonly db: DatabaseSync;
  constructor(filename: string, private readonly now: () => number = Date.now) {
    if (!isAbsolute(filename)) throw new Error("Admin storage requires an independent absolute path");
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const canonical = existsSync(filename) ? realpathSync(filename) : resolve(filename);
    this.db = new DatabaseSync(canonical);
    try {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (tables.some(table => /^(engineering_|requirement_|business_contract$|direct_contract$|chain_drafts$)/.test(String(table.name))) || tables.length && !tables.some(table => table.name === "admin_control")) throw new Error("Admin storage cannot reuse a business or unrelated database");
      const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
      if (version > 1) throw new Error("Admin database version is newer than this worker");
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
        PRAGMA user_version=1; COMMIT;`);
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  control() { return this.db.prepare("SELECT * FROM admin_control WHERE singleton=1").get() as unknown as Control; }
  acquireSupervisor(ownerId: string, leaseMs = 30000): AdminAuthority | null {
    text.parse(ownerId);
    if (!Number.isFinite(leaseMs) || leaseMs < 1000) throw new Error("Invalid Admin supervision lease");
    return this.transaction(() => {
      const control = this.control(), now = this.now();
      if (control.owner_id !== ownerId && control.expires_at > now) return null;
      const token = control.owner_id === ownerId && control.expires_at > now ? control.fencing_token : control.fencing_token + 1;
      this.db.prepare("UPDATE admin_control SET owner_id=?,fencing_token=?,expires_at=? WHERE singleton=1").run(ownerId, token, now + leaseMs);
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
        this.db.prepare("UPDATE admin_case SET status=CASE WHEN status IN ('closed','verifying','observing') AND ?<>'admin' THEN 'queued' ELSE status END,updated_at=? WHERE case_id=?")
          .run(observation.origin, this.now(), repairCase.case_id);
      }
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
      execution_connected: false };
  }
  close() { this.db.close(); }
}

export const adminRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("acquire"), owner_id: text }),
  z.strictObject({ action: z.literal("renew"), authority: adminAuthoritySchema }),
  z.strictObject({ action: z.literal("release"), authority: adminAuthoritySchema }),
  z.strictObject({ action: z.literal("observe"), authority: adminAuthoritySchema, observation: repairObservationSchema }),
  z.strictObject({ action: z.literal("issue"), workspace_id: z.uuid(), issue_id: z.uuid() }),
]);
export function invokeAdmin(store: AdminStore, input: unknown) {
  const request = adminRequestSchema.parse(input);
  switch (request.action) {
    case "acquire": return { authority: store.acquireSupervisor(request.owner_id) };
    case "renew": return { renewed: store.renewSupervisor(request.authority) };
    case "release": return store.releaseSupervisor(request.authority);
    case "observe": return store.observe(request.authority, request.observation);
    case "issue": return store.issue(request.workspace_id, request.issue_id);
  }
}
