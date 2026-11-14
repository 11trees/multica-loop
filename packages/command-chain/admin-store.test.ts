// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AdminStore, type RepairObservation } from "./admin-store";

let directory: string, filename: string, store: AdminStore, now: number;
const workspaceId=randomUUID(),issueId=randomUUID();
const observation=(extra:Partial<RepairObservation>={}):RepairObservation=>({observationId:randomUUID(),workspaceId,issueId,scope:"work-item",scopeKey:`${workspaceId}:${issueId}:verification`,fingerprint:"original-conflict",sourceVersion:"sha256:"+"a".repeat(64),summary:"Original conflict",evidence:{original:{input:"Preserve the original oracle"}},origin:"business",...extra});
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),"multica-admin-"));filename=join(directory,"admin.sqlite");now=1000;store=new AdminStore(filename,()=>now);});
afterEach(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
it("keeps one immutable observation and one work-item cohort across restart and changed failure signatures",()=>{
 const authority=store.acquireSupervisor("host")!,first=observation(),repair=store.observe(authority,first);expect(store.observe(authority,first)).toEqual(repair);
 const additional=observation({fingerprint:"different-failure",summary:"Retain another original failure"});expect(store.observe(authority,additional).caseId).toBe(repair.caseId);
 store.close();store=new AdminStore(filename,()=>now);expect(store.observe(authority,first).originalSummary).toBe(first.summary);
 expect(store.issue(workspaceId,issueId)).toMatchObject({recorded:true,case_id:repair.caseId,observation_count:2,original_version:first.sourceVersion,desired_intent:"stopped",execution_connected:false});
 expect(()=>store.observe(authority,{...first,evidence:{changed:true}})).toThrow(/different original evidence/);
});
it("fences competing and expired supervisors and never lets old release or renewal change a new owner",()=>{
 const first=store.acquireSupervisor("first",1000)!;expect(store.acquireSupervisor("second",1000)).toBeNull();expect(store.renewSupervisor(first,1000)).toBe(true);
 now+=1001;expect(store.renewSupervisor(first)).toBe(false);const second=store.acquireSupervisor("second")!;expect(second.token).toBeGreaterThan(first.token);
 expect(store.releaseSupervisor(first).released).toBe(false);expect(()=>store.observe(first,observation())).toThrow(/authority expired or changed/);expect(store.renewSupervisor(second)).toBe(true);
 store.observe(second,observation());expect(store.control().desired_intent).toBe("stopped");
});
it("isolates workspaces and prevents recursively creating an Admin Case for its own faults",()=>{
 const authority=store.acquireSupervisor("host")!,first=observation(),repair=store.observe(authority,first),other=observation({workspaceId:randomUUID()});expect(store.observe(authority,other).caseId).not.toBe(repair.caseId);
 expect(store.issue(randomUUID(),issueId)).toEqual({recorded:false});expect(()=>store.observe(authority,observation({origin:"admin"}))).toThrow(/recursive repair/);
 expect(store.observe(authority,observation({origin:"admin",repairCaseId:repair.caseId})).caseId).toBe(repair.caseId);
 expect(()=>store.observe(authority,observation({workspaceId:other.workspaceId,origin:"admin",repairCaseId:repair.caseId}))).toThrow(/original Case/);
});
it("refuses business, unrelated and newer databases before management schema creation",()=>{
 const business=join(directory,"business.sqlite"),db=new DatabaseSync(business);db.exec("CREATE TABLE engineering_contract(id TEXT)");db.close();expect(()=>new AdminStore(business)).toThrow(/business or unrelated/);
 const check=new DatabaseSync(business);expect(check.prepare("SELECT name FROM sqlite_master WHERE name='admin_control'").get()).toBeUndefined();check.close();
 const newer=join(directory,"newer.sqlite"),future=new DatabaseSync(newer);future.exec("CREATE TABLE admin_control(singleton INTEGER);PRAGMA user_version=2");future.close();expect(()=>new AdminStore(newer)).toThrow(/newer/);
});
