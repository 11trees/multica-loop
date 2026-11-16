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
 const newer=join(directory,"newer.sqlite"),future=new DatabaseSync(newer);future.exec("CREATE TABLE admin_control(singleton INTEGER);PRAGMA user_version=12");future.close();expect(()=>new AdminStore(newer)).toThrow(/newer/);
});
it("upgrades an existing observation database without rewriting its Case or granting execution",()=>{
 const authority=store.acquireSupervisor("existing-host")!,original=observation(),repair=store.observe(authority,original);
 store.close();const prior=new DatabaseSync(filename);
 for(const table of ["admin_runtime","admin_intent_command","admin_attempt","admin_schedule","admin_evidence"])prior.exec(`DROP TABLE ${table}`);
 prior.exec("ALTER TABLE admin_control DROP COLUMN execution_supported;PRAGMA user_version=1");prior.close();
 store=new AdminStore(filename,()=>now);
 expect(store.observe(authority,original)).toEqual(repair);
 expect(store.issue(workspaceId,issueId)).toMatchObject({case_id:repair.caseId,observation_count:1,desired_intent:"stopped",execution_connected:false});
 expect(store.execution.configuration()).toBeNull();expect(store.execution.claim(authority)).toBeNull();
});
it("upgrades schema two with pending Cases while keeping Admin stopped and preserving original evidence",()=>{
 const authority=store.acquireSupervisor("upgrade-host")!,original=observation(),repair=store.observe(authority,original);
 store.close();const prior=new DatabaseSync(filename);prior.exec("DROP TABLE admin_takeover;PRAGMA user_version=2");prior.close();
 store=new AdminStore(filename,()=>now);
 expect(store.observe(authority,original)).toEqual(repair);
 expect(store.control()).toMatchObject({desired_intent:"stopped",intent_revision:0});
 expect(store.execution.pendingTakeovers(authority)).toEqual([]);
 const check=new DatabaseSync(filename);expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(11);expect(check.prepare("SELECT count(*) AS n FROM admin_observation").get()!.n).toBe(1);check.close();
});

it("upgrades schema three with separate physical progress storage and preserves original Cases",()=>{
 const authority=store.acquireSupervisor("schema-three")!,original=observation(),repair=store.observe(authority,original);
 store.close();const prior=new DatabaseSync(filename);prior.exec("DROP TABLE admin_takeover_progress;PRAGMA user_version=3");prior.close();
 store=new AdminStore(filename,()=>now);expect(store.observe(authority,original)).toEqual(repair);expect(store.control()).toMatchObject({desired_intent:"stopped",intent_revision:0});
 const check=new DatabaseSync(filename);expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(11);expect(check.prepare("SELECT count(*) AS n FROM admin_takeover_progress").get()!.n).toBe(0);check.close();
});

it("upgrades schema four without changing original Cases or creating verification work",()=>{
 const authority=store.acquireSupervisor("schema-four")!,original=observation(),repair=store.observe(authority,original);
 store.close();const prior=new DatabaseSync(filename);prior.exec("DROP TABLE admin_verification_input;PRAGMA user_version=4");prior.close();
 store=new AdminStore(filename,()=>now);expect(store.observe(authority,original)).toEqual(repair);expect(store.control()).toMatchObject({desired_intent:"stopped",intent_revision:0});
 const check=new DatabaseSync(filename);expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(11);expect(check.prepare("SELECT count(*) AS n FROM admin_verification_input").get()!.n).toBe(0);check.close();
 expect(store.execution.active()).toEqual([]);expect(store.execution.configuration()).toBeNull();
});

it("upgrades schema five to retain a single active slot including never-launched waiting Tests",()=>{
 const authority=store.acquireSupervisor("schema-five")!,original=observation(),repair=store.observe(authority,original);
 store.close();const prior=new DatabaseSync(filename);prior.exec("DROP TABLE admin_verification_plan;DROP INDEX admin_one_live_attempt;CREATE UNIQUE INDEX admin_one_live_attempt ON admin_attempt((1)) WHERE status IN ('launching','running');PRAGMA user_version=5");prior.close();
 store=new AdminStore(filename,()=>now);expect(store.observe(authority,original)).toEqual(repair);expect(store.control()).toMatchObject({desired_intent:"stopped",intent_revision:0});
 const check=new DatabaseSync(filename);expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(11);expect(String(check.prepare("SELECT sql FROM sqlite_master WHERE name='admin_one_live_attempt'").get()!.sql)).toContain("waiting");check.close();expect(store.execution.active()).toEqual([]);
});

it("upgrades schema six with empty native receipts while retaining original Cases and stopped intent",()=>{
 const authority=store.acquireSupervisor("schema-six")!,original=observation(),repair=store.observe(authority,original);
 store.close();const prior=new DatabaseSync(filename);prior.exec("DROP TABLE admin_verification_check;DROP TABLE admin_verification_receipt;PRAGMA user_version=6");prior.close();
 store=new AdminStore(filename,()=>now);expect(store.observe(authority,original)).toEqual(repair);expect(store.control()).toMatchObject({desired_intent:"stopped",intent_revision:0});
 const check=new DatabaseSync(filename);expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(11);expect(check.prepare("SELECT count(*) AS n FROM admin_verification_check").get()!.n).toBe(0);expect(check.prepare("SELECT count(*) AS n FROM admin_verification_receipt").get()!.n).toBe(0);check.close();
});

it("upgrades schema seven by retaining old inputs and originals while requeueing unbound prepared repairs",()=>{
 const authority=store.acquireSupervisor("schema-seven")!,original=observation(),repair=store.observe(authority,original);
 store.close();const prior=new DatabaseSync(filename);prior.exec("DROP TABLE admin_repair_write;DROP TABLE admin_repair_candidate;PRAGMA user_version=7");prior.prepare("UPDATE admin_case SET status='verification-prepared' WHERE case_id=?").run(repair.caseId);prior.prepare("INSERT INTO admin_verification_input VALUES(?,?)").run("legacy-seven",JSON.stringify({original:"retained old input"}));prior.close();
 store=new AdminStore(filename,()=>now);expect(store.issue(workspaceId,issueId)).toMatchObject({status:"queued",observation_count:1,desired_intent:"stopped"});
 const check=new DatabaseSync(filename);expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(11);expect(check.prepare("SELECT payload FROM admin_verification_input WHERE attempt_id='legacy-seven'").get()!.payload).toBe(JSON.stringify({original:"retained old input"}));expect(check.prepare("SELECT count(*) AS n FROM admin_repair_write").get()!.n).toBe(0);check.close();
});

it("upgrades schema eight with an empty handoff ledger while preserving original Cases and stopped intent",()=>{
 const authority=store.acquireSupervisor("schema-eight")!,original=observation(),repair=store.observe(authority,original);
 store.close();const previous=new DatabaseSync(filename);previous.exec("DROP TABLE admin_handoff_preparation;PRAGMA user_version=8");previous.close();
 store=new AdminStore(filename,()=>now);expect(store.observe(authority,original)).toEqual(repair);expect(store.control().desired_intent).toBe("stopped");
 const check=new DatabaseSync(filename);expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(11);expect(check.prepare("SELECT count(*) AS n FROM admin_handoff_preparation").get()!.n).toBe(0);check.close();
});

it("upgrades schema nine without discarding handoff proposals or enabling execution",()=>{
 const authority=store.acquireSupervisor("schema-nine")!,original=observation(),repair=store.observe(authority,original);
 store.close();const previous=new DatabaseSync(filename);previous.exec("DROP TABLE admin_handoff_reservation;PRAGMA user_version=9");
 const proposal=JSON.stringify({retained:"Exact historical proposal"});previous.prepare("INSERT INTO admin_handoff_preparation VALUES(?,?,?)").run(repair.caseId,"verified",proposal);previous.close();
 store=new AdminStore(filename,()=>now);expect(store.control().desired_intent).toBe("stopped");expect(store.observe(authority,original)).toEqual(repair);
 const check=new DatabaseSync(filename);expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(11);expect(check.prepare("SELECT payload FROM admin_handoff_preparation").get()!.payload).toBe(proposal);expect(check.prepare("SELECT count(*) AS n FROM admin_handoff_reservation").get()!.n).toBe(0);check.close();
});
it("upgrades schema ten without discarding native reservations or enabling execution",()=>{
 const authority=store.acquireSupervisor("schema-ten")!,original=observation(),repair=store.observe(authority,original);
 store.close();const previous=new DatabaseSync(filename);previous.exec("DROP TABLE admin_handoff_application;PRAGMA user_version=10");const payload=JSON.stringify({retained:"Historical native reservation"});previous.prepare("INSERT INTO admin_handoff_reservation VALUES(?,?,?)").run(repair.caseId,"verified",payload);previous.close();
 store=new AdminStore(filename,()=>now);expect(store.control().desired_intent).toBe("stopped");expect(store.observe(authority,original)).toEqual(repair);
 const check=new DatabaseSync(filename);expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(11);expect(check.prepare("SELECT payload FROM admin_handoff_reservation").get()!.payload).toBe(payload);expect(check.prepare("SELECT count(*) AS n FROM admin_handoff_application").get()!.n).toBe(0);check.close();
});
