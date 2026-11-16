import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DraftConflictError } from "./runtime";
import { initializeInterventions } from "./intervention-store";
const text = z.string().trim().min(1);
const ownerSchema = z.strictObject({ workspaceId: z.uuid(), issueId: z.uuid(), agentId: z.uuid(), attemptId: text });
type Owner = z.infer<typeof ownerSchema>;
const identity = z.strictObject({ allocation_id: z.uuid(), runtime_id: z.uuid(), host_id: text });
export const processRequestSchema = z.discriminatedUnion("operation", [
    identity.extend({ operation: z.literal("reserve"), provider: z.literal("codex") }),
    identity.extend({ operation: z.literal("bind"), pid: z.number().int().positive(), marker: text, group_id: z.number().int().positive() }),
    identity.extend({ operation: z.literal("exit"), pid: z.number().int().nonnegative(), exit_confirmed: z.boolean() }),
]);
/** Physical records survive task termination and protocol surrender. */
export class EngineeringProcessStore {
    constructor(private readonly db: DatabaseSync) {
        initializeInterventions(db);
        db.exec(`
 CREATE TABLE IF NOT EXISTS engineering_process_binding(workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,agent_id TEXT NOT NULL,attempt_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id,agent_id,attempt_id));
 CREATE TABLE IF NOT EXISTS engineering_process(allocation_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,attempt_id TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS engineering_process_live_issue ON engineering_process(workspace_id,issue_id) WHERE status<>'exited';`);
    }
    private transaction<T>(work: () => T) { this.db.exec("BEGIN IMMEDIATE"); try {
        const result = work();
        this.db.exec("COMMIT");
        return result;
    }
    catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
    } }
    bind(owner: Owner, projectId: string | undefined, repositoryPath: string, mode: "in_place" | "worktree") {
        owner = ownerSchema.parse(owner);
        const payload = JSON.stringify({ projectId: projectId ?? null, repositoryPath, mode });
        this.db.exec("SAVEPOINT physical_repository_binding");try {
            if(this.db.prepare("SELECT 1 FROM engineering_repair_retired_claim WHERE workspace_id=? AND issue_id=? AND attempt_id=?").get(owner.workspaceId,owner.issueId,owner.attemptId))throw new DraftConflictError("Native execution claim was replaced");
            const prior = this.db.prepare("SELECT payload FROM engineering_process_binding WHERE workspace_id=? AND issue_id=? AND agent_id=? AND attempt_id=?").get(owner.workspaceId, owner.issueId, owner.agentId, owner.attemptId);
            if (prior && prior.payload !== payload)
                throw new DraftConflictError("Physical process repository binding cannot change within a native claim");
            this.db.prepare("INSERT OR IGNORE INTO engineering_process_binding VALUES(?,?,?,?,?)").run(owner.workspaceId, owner.issueId, owner.agentId, owner.attemptId, payload);
        this.db.exec("RELEASE physical_repository_binding");
        }catch(error){this.db.exec("ROLLBACK TO physical_repository_binding;RELEASE physical_repository_binding");throw error;}
    }
    invoke(owner: Owner, input: unknown, surrendered = false, projectId?: string) {
        owner = ownerSchema.parse(owner);
        const request = processRequestSchema.parse(input);
        return this.transaction(() => {
            const blocked = surrendered || !!this.db.prepare("SELECT 1 FROM engineering_intervention WHERE workspace_id=? AND issue_id=? AND attempt_id=? UNION ALL SELECT 1 FROM engineering_intervention_pending WHERE workspace_id=? AND issue_id=? UNION ALL SELECT 1 FROM engineering_repair_retired_claim WHERE workspace_id=? AND issue_id=? AND attempt_id=? LIMIT 1").get(owner.workspaceId, owner.issueId, owner.attemptId, owner.workspaceId, owner.issueId,owner.workspaceId,owner.issueId,owner.attemptId);
            const row = this.db.prepare("SELECT payload,status FROM engineering_process WHERE allocation_id=?").get(request.allocation_id);
            if (request.operation === "reserve") {
                if (row) {
                    const saved = JSON.parse(String(row.payload));
                    if (JSON.stringify(saved.owner) !== JSON.stringify(owner) || saved.runtimeId !== request.runtime_id || saved.hostId !== request.host_id || saved.provider !== request.provider)
                        throw new DraftConflictError("Process allocation ID belongs to another native claim");
                    return { reserved: true, status: row.status };
                }
                if (blocked)
                    throw new DraftConflictError("Surrendered work cannot reserve another provider process");
                const binding = this.db.prepare("SELECT payload FROM engineering_process_binding WHERE workspace_id=? AND issue_id=? AND agent_id=? AND attempt_id=?").get(owner.workspaceId, owner.issueId, owner.agentId, owner.attemptId);
                if (!binding)
                    throw new DraftConflictError("Bind the actual native repository before reserving a process");
                if (JSON.parse(String(binding.payload)).projectId !== (projectId ?? null))
                    throw new DraftConflictError("Native project changed after repository binding");
                if (this.db.prepare("SELECT 1 FROM engineering_process WHERE workspace_id=? AND issue_id=? AND status<>'exited'").get(owner.workspaceId, owner.issueId))
                    throw new DraftConflictError("Previous native process has not confirmed physical exit");
                const value = { allocationId: request.allocation_id, owner, runtimeId: request.runtime_id, hostId: request.host_id, provider: request.provider, ...JSON.parse(String(binding.payload)), pid: null, marker: null, groupId: null, reservedAt: new Date().toISOString(), exitedAt: null };
                this.db.prepare("INSERT INTO engineering_process VALUES(?,?,?,?,?,?)").run(request.allocation_id, owner.workspaceId, owner.issueId, owner.attemptId, "launching", JSON.stringify(value));
                return { reserved: true, status: "launching" };
            }
            if (!row)
                throw new DraftConflictError("Native process allocation is unavailable");
            const value = JSON.parse(String(row.payload));
            if (JSON.stringify(value.owner) !== JSON.stringify(owner) || value.runtimeId !== request.runtime_id || value.hostId !== request.host_id)
                throw new DraftConflictError("Process mutation belongs to another native claim or host");
            if (request.operation === "bind") {
                if (blocked || row.status === "exited")
                    throw new DraftConflictError("Inactive process allocation cannot accept a PID");
                if (request.pid !== request.group_id || value.pid !== null && (value.pid !== request.pid || value.marker !== request.marker || value.groupId !== request.group_id))
                    throw new DraftConflictError("Native process birth identity cannot be replaced");
                Object.assign(value, { pid: request.pid, marker: request.marker, groupId: request.group_id });
                this.db.prepare("UPDATE engineering_process SET status='running',payload=? WHERE allocation_id=?").run(JSON.stringify(value), request.allocation_id);
                return { bound: true };
            }
            if (row.status === "exited") {
                if (value.exitPID !== request.pid)
                    throw new DraftConflictError("Physical exit receipt cannot be rewritten");
                return { exited: true };
            }
            if (!request.exit_confirmed)
                return { exited: false };
            if (value.pid !== null && value.pid !== request.pid)
                throw new DraftConflictError("Physical exit belongs to another process");
            value.exitPID = request.pid;
            value.exitedAt = new Date().toISOString();
            this.db.prepare("UPDATE engineering_process SET status='exited',payload=? WHERE allocation_id=?").run(JSON.stringify(value), request.allocation_id);
            return { exited: true };
        });
    }
    scope(workspaceId: string, issueId: string) {
        const bindings = this.db.prepare("SELECT payload FROM engineering_process_binding WHERE workspace_id=? AND issue_id=? ORDER BY rowid").all(workspaceId, issueId).map(row => JSON.parse(String(row.payload)));
        const allocations = this.db.prepare("SELECT status,payload FROM engineering_process WHERE workspace_id=? AND issue_id=? ORDER BY rowid").all(workspaceId, issueId).map(row => ({ ...JSON.parse(String(row.payload)), status: row.status }));
        return { bindings, allocations };
    }
    repository(owner:Owner){
        owner=ownerSchema.parse(owner);
        const row=this.db.prepare("SELECT payload FROM engineering_process_binding WHERE workspace_id=? AND issue_id=? AND agent_id=? AND attempt_id=?").get(owner.workspaceId,owner.issueId,owner.agentId,owner.attemptId);
        return row?z.strictObject({projectId:z.uuid().nullable(),repositoryPath:text,mode:z.enum(["in_place","worktree"])}).parse(JSON.parse(String(row.payload))):null;
    }
    assertExited(workspaceId: string, issueId: string) { if (this.db.prepare("SELECT 1 FROM engineering_process WHERE workspace_id=? AND issue_id=? AND status<>'exited'").get(workspaceId, issueId))
        throw new DraftConflictError("Native provider process has not confirmed physical exit"); }
}
