// @vitest-environment node
import {repairRecoveryFaultHash,repairRecoveryFaultSchema} from "./repair-recovery-fault";
import { createHash,randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { repairHandoffTargetSchema,handoffProposalSchema,handoffReadySchema,handoffApplicationSchema,handoffHash } from "./repair-handoff";
import {repairExecutionHintSchema,repairExecutionHintHash} from "./repair-execution";
import {repairBusinessProgressSchema} from "./repair-progress";
import {draftSchema} from "./runtime";
import { readRepairWorkspaceVersion } from "./repair-workspace-version";
import { hostRecoveryFaultFixture as recoveryFault,hostHandoffReservationFixture } from "./test-helpers/repair-handoff-fixture";
import { EngineeringTeamStore } from "./team-store";
import { EngineeringApplication, type ApplicationRequest } from "./application";
import { SqliteDraftStore } from "./sqlite-store";
import { InterventionStore, interventionRequestSchema } from "./intervention-store";

const human = { kind: "human" as const, workspaceId: randomUUID(), issueId: randomUUID(), userId: randomUUID() };
const agentId = randomUUID(), projectId = randomUUID();
const owner = { kind: "task" as const, workspaceId: human.workspaceId, issueId: human.issueId, agentId, projectId, attemptId: `${randomUUID()}:123456` };
const host = { kind: "host" as const, workspaceId: human.workspaceId, issueId: human.issueId };
const body = { summary: "Frozen scope contradicts the observed entry", reason: "The supplied answer does not establish the original oracle", evidence: "# Investigation\n\nThe original contract and README.md disagree." };
let directory: string, repository: string, database: string, definition: string, app: EngineeringApplication;
const invoke = (actor: ApplicationRequest["actor"], action: ApplicationRequest["action"], payload?: unknown) => app.invoke({ actor, action, payload });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "intervention-host-")); repository = join(directory, "repository"); database = join(directory, "state.sqlite");
  execFileSync("git", ["init", "-q", repository]); repository = await realpath(repository);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
  git("config", "user.name", "Intervention fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "README.md"), "Original source\n"); git("add", "."); git("commit", "-qm", "Original fixture");
  definition = await readFile(new URL("./definitions/verification.yaml", import.meta.url), "utf8"); app = new EngineeringApplication(database, definition);
});
afterEach(async () => { app.close(); await rm(directory, { recursive: true, force: true }); });
async function direct() {
  await invoke(human, "configure-direct", { expected_revision: 0, agent_id: agentId, project_id: projectId, repository_path: repository, input: "Read the source faithfully", execution_resources: [{ path: repository, mode: "in_place" }] });
  await invoke({ ...owner, kind: "daemon" }, "bind", { work_dir: repository, mode: "in_place", overlays: [] });
}
it("surrenders Direct only after RUN, persists one exact terminal receipt and blocks all advancement after reopening", async () => {
  expect(await invoke(host,"execution-permission")).toEqual({allowed:true});
  await expect(invoke(owner,"execution-permission")).rejects.toThrow(/native host/);
  await direct(); await expect(invoke(owner, "intervention-request", body)).rejects.toThrow(/Direct RUN/);
  await invoke(owner, "direct-run"); const result = await invoke(owner, "intervention-request", body);
  expect(result).toMatchObject({ submitted: true, owner: "admin", agent_action: "end_execution", intervention: { status: "pending_admin", chain: "direct", phase: "run", ...body } });
  app.close(); app = new EngineeringApplication(database, definition);
  expect(await invoke(owner, "intervention-request", body)).toEqual(result);
  await expect(invoke(owner, "intervention-request", { ...body, reason: "Replace history" })).rejects.toThrow(/immutable/);
  for (const action of ["direct-submit", "direct-run", "prepare-run", "selection", "completion", "configure"] as const) {
    await expect(invoke(action === "completion" ? host : owner, action, { summary: "Do not complete" })).rejects.toThrow(/surrendered/);
  }
  expect(await invoke(host,"execution-permission")).toEqual({allowed:false});
  expect(await invoke(human, "overview")).toMatchObject({ status: "waiting_for_intervention", direct: { result: null }, intervention: { summary: body.summary } });
  expect(await invoke({ kind: "coordinator" }, "continuations")).toEqual([]);
  const observations = await invoke({ kind: "coordinator" }, "repair-observations");
  expect(observations).toEqual([expect.objectContaining({ attemptId: owner.attemptId, snapshot: expect.objectContaining({ direct: expect.objectContaining({ input: "Read the source faithfully" }) }) })]);
  await expect(invoke(owner, "repair-observations")).rejects.toThrow(/Only the host/);
});
it("requires this attempt's viewed editable YAML draft and preserves it against a writer that read before surrender", async () => {
  await invoke(human, "configure", { expected_revision: 0, agent_id: agentId, repository_path: repository, sources: [{ key: "original", kind: "acceptance", description: "Original entry", oracle: "Observe the original entry", sourceRef: "README.md" }] });
  await invoke({ ...owner, kind: "daemon" }, "bind", { work_dir: repository, mode: "in_place", overlays: [] });
  await expect(invoke(owner, "intervention-request", body)).rejects.toThrow(/editable checkpoint/);
  const state = await invoke(owner, "start"); if (!("draft" in state) || !state.draft) throw new Error("Missing fixture draft");
  const store = new SqliteDraftStore(database), before = await store.read(state.draft.id); if (!before) throw new Error("Missing draft");
  await writeFile(join(repository, "observed-drift.md"), "Readonly workspace drift must still be reportable\n");
  await invoke(owner, "intervention-request", body);
  await expect(invoke(owner, "command", { expected_sequence: before.sequence, command: { type: "phase.complete" } })).rejects.toThrow(/surrendered/);
  await expect(store.save({ ...before, sequence: before.sequence + 1 }, before.sequence)).rejects.toThrow(/Draft changed/);
  await expect(store.save({ ...before, sequence: before.sequence + 1, binding: { ...before.binding, workspaceId: randomUUID(), issueId: randomUUID() } }, before.sequence)).rejects.toThrow(/Draft changed/);
  expect(await store.read(before.id)).toEqual(before); store.close();
});
it("keeps surrendered attempt authority revoked independently of the issue's active hold", async () => {
  await direct(); await invoke(owner, "direct-run");
  const receipt = await invoke(owner, "intervention-request", body);
  const activeHold = vi.spyOn(InterventionStore.prototype, "pending").mockReturnValue(undefined);
  try {
    // Only the active-hold lookup is absent; immutable surrender history remains.
    expect(await invoke(host, "execution-permission")).toEqual({ allowed: true });
    expect(await invoke(owner, "read")).toMatchObject({ agent_action: "end_execution", direct: { result: null } });
    expect(await invoke(owner, "overview")).toMatchObject({ agent_action: "end_execution" });
    expect(await invoke(owner, "intervention-request", body)).toEqual(receipt);
    await expect(invoke(owner, "intervention-request", { ...body, reason: "Replace the original" })).rejects.toThrow(/immutable/);
    for (const action of ["direct-run", "direct-submit", "prepare-run", "command", "parent-scope"] as const) await expect(invoke(owner, action, {})).rejects.toThrow(/surrendered/);
    const daemon = { ...owner, kind: "daemon" as const };
    await expect(invoke(daemon, "bind", { work_dir: repository, mode: "in_place", overlays: [] })).rejects.toThrow(/surrendered/);
    await expect(invoke(daemon, "process", { operation: "reserve", allocation_id: randomUUID(), runtime_id: randomUUID(), host_id: "test-host", provider: "codex" })).rejects.toThrow(/Surrendered/);
  } finally { activeHold.mockRestore(); }
});
it("rejects human, foreign agent and unviewed attempts without creating observations", async () => {
  await direct(); await invoke(owner, "direct-run");
  await expect(invoke(human, "intervention-request", body)).rejects.toThrow(/native task/);
  await expect(invoke({ ...owner, agentId: randomUUID() }, "intervention-request", body)).rejects.toThrow(/agent|role/);
  const db = new DatabaseSync(database); db.prepare("DELETE FROM engineering_intervention_view").run(); db.close();
  await expect(invoke(owner, "intervention-request", body)).rejects.toThrow(/Read this attempt/);
  expect(await invoke({ kind: "coordinator" }, "repair-observations")).toEqual([]);
});
it("refuses a request after an explicit Direct result", async () => {
  await direct(); await invoke(owner, "direct-run"); await invoke(owner, "direct-submit", { summary: "Actual result" });
  await expect(invoke(owner, "intervention-request", body)).rejects.toThrow(/submitted work/);
});
it("enforces the source request's separate summary, reason and evidence limits", () => {
  expect(interventionRequestSchema.parse(body)).toEqual(body);
  for (const invalid of [{ ...body, summary: "x".repeat(4001) }, { ...body, reason: "x".repeat(8001) }, { ...body, evidence: "x".repeat(100001) }, { ...body, issue_id: randomUUID() }]) expect(() => interventionRequestSchema.parse(invalid)).toThrow();
});

it("revalidates the original checkpoint and immutable receipt identity on later reads", async () => {
 await direct();await invoke(owner,"direct-run");await invoke(owner,"intervention-request",body);
 await writeFile(join(repository,"later-work.md"),"Unrelated later workspace change\n");
 expect(await invoke(owner,"read")).toMatchObject({agent_action:"end_execution",intervention:{summary:body.summary}});
 const db=new DatabaseSync(database),row=db.prepare("SELECT payload FROM engineering_intervention").get()!,record=JSON.parse(String(row.payload));record.phase="fabricated-phase";db.prepare("UPDATE engineering_intervention SET payload=?").run(JSON.stringify(record));db.close();
 await expect(invoke(human,"overview")).rejects.toThrow(/identity or receipt changed/);
});

it("validates the acknowledged original Direct source without granting ownership or probing a removed directory", async () => {
  await direct(); await invoke(owner, "direct-run"); await invoke(owner, "intervention-request", body);
  const [original] = await invoke({kind:"coordinator"}, "repair-observations") as Array<{observationId:string;snapshotHash:string}>;
  const pin = {observation_id:original!.observationId, snapshot_hash:original!.snapshotHash, case_id:"REPAIR-original"};
  await expect(invoke(host,"repair-source",pin)).rejects.toThrow(/acknowledged Admin Case/);
  await invoke(host,"repair-observation-ack",pin);
  for (const actor of [owner,human,{...owner,kind:"daemon" as const},{kind:"coordinator" as const}]) {
    await expect(invoke(actor,"repair-source",pin)).rejects.toThrow(/Only the host/);
  }
  const expected = {observation_id:pin.observation_id,case_id:pin.case_id,attempt_id:owner.attemptId,registered_repository_path:repository,execution_repository_path:repository,mode:"in_place"};
  expect(await invoke(host,"repair-source",pin)).toMatchObject(expected);
  for (const change of [{case_id:"REPAIR-foreign"},{snapshot_hash:"changed"},{observation_id:"changed"},{workspace_path:"/invented"}]) {
    await expect(invoke(host,"repair-source",{...pin,...change})).rejects.toThrow();
  }
  await rm(repository,{recursive:true});
  app.close();app=new EngineeringApplication(database,definition);
  expect(await invoke(host,"repair-source",pin)).toMatchObject(expected);
  await expect(invoke(host,"repair-workspace-version",pin)).rejects.toThrow(/ENOENT/);
  expect(await invoke(host,"execution-permission")).toEqual({allowed:false});
  const db = new DatabaseSync(database),row=db.prepare("SELECT payload FROM direct_contract").get()!,record=JSON.parse(String(row.payload));
  record.version++;db.prepare("UPDATE direct_contract SET payload=?").run(JSON.stringify(record));db.close();
  await expect(invoke(host,"repair-source",pin)).rejects.toThrow(/checkpoint changed/);
});

it("reads current content only through the pinned host source without rewriting its original version", async () => {
  await direct(); await invoke(owner,"direct-run"); await invoke(owner,"intervention-request",body);
  const [original]=await invoke({kind:"coordinator"},"repair-observations") as Array<{observationId:string;snapshotHash:string}>;
  const pin={observation_id:original!.observationId,snapshot_hash:original!.snapshotHash,case_id:"REPAIR-version"};
  await invoke(host,"repair-observation-ack",pin);
  const source=await invoke(host,"repair-source",pin);
  for(const actor of [human,owner,{...owner,kind:"daemon" as const},{kind:"coordinator" as const}]) await expect(invoke(actor,"repair-workspace-version",pin)).rejects.toThrow(/Only the host/);
  const first=await invoke(host,"repair-workspace-version",pin);
  expect(first).toMatchObject({source_attempt_id:owner.attemptId,snapshot_hash:pin.snapshot_hash,workspace_root:repository,workspace_version:expect.stringMatching(/^workspace-content-v1:/)});
  await writeFile(join(repository,"actual-change.txt"),"Uncommitted repair candidate\n");
  expect(await invoke(host,"repair-workspace-version",pin)).not.toEqual(first);
  expect(await invoke(host,"repair-source",pin)).toEqual(source);
  await expect(invoke(host,"repair-workspace-version",{...pin,repository_path:"/invented"})).rejects.toThrow();
  expect(await invoke(host,"execution-permission")).toEqual({allowed:false});
});

it("pins the exact surrendered YAML draft and the original runtime binding", async () => {
  await invoke(human,"configure",{expected_revision:0,agent_id:agentId,repository_path:repository,sources:[{key:"original",kind:"acceptance",description:"Original",oracle:"Observe source",sourceRef:"README.md"}]});
  await invoke({...owner,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});
  await invoke(owner,"start");await invoke(owner,"intervention-request",body);
  const [original]=await invoke({kind:"coordinator"},"repair-observations") as Array<{observationId:string;snapshotHash:string;draftId:string}>;
  const pin={observation_id:original!.observationId,snapshot_hash:original!.snapshotHash,case_id:"REPAIR-yaml"};
  await invoke(host,"repair-observation-ack",pin);
  expect(await invoke(host,"repair-source",pin)).toMatchObject({chain:"verification",attempt_id:owner.attemptId,execution_repository_path:repository});
  const db=new DatabaseSync(database),row=db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(original!.draftId)!,draft=JSON.parse(String(row.payload));
  const binding=db.prepare("SELECT payload FROM engineering_execution").get()!;
  db.prepare("DELETE FROM engineering_execution").run();
  await expect(invoke(host,"repair-source",pin)).rejects.toThrow(/bind its actual repository/);
  db.prepare("INSERT INTO engineering_execution(workspace_id,issue_id,revision,agent_id,attempt_id,payload) VALUES(?,?,?,?,?,?)").run(human.workspaceId,human.issueId,1,agentId,owner.attemptId,String(binding.payload));
  draft.sequence++;db.prepare("UPDATE chain_drafts SET payload=? WHERE id=?").run(JSON.stringify(draft),original!.draftId);db.close();
  await expect(invoke(host,"repair-source",pin)).rejects.toThrow(/checkpoint changed/);
});

it("retains distinct registered and execution paths after the surrendered worktree is removed", async () => {
  const worktree=join(directory,"execution");
  execFileSync("git",["-C",repository,"worktree","add","-qb","fixture-execution",worktree]);
  const execution=await realpath(worktree);
  await invoke(human,"configure-direct",{expected_revision:0,agent_id:agentId,project_id:projectId,repository_path:repository,input:"Original worktree scope",execution_resources:[{path:repository,mode:"worktree"}]});
  await invoke({...owner,kind:"daemon"},"bind",{work_dir:execution,mode:"worktree",overlays:[]});
  await invoke(owner,"direct-run");await invoke(owner,"intervention-request",body);
  const [original]=await invoke({kind:"coordinator"},"repair-observations") as Array<{observationId:string;snapshotHash:string}>;
  const pin={observation_id:original!.observationId,snapshot_hash:original!.snapshotHash,case_id:"REPAIR-worktree"};
  await invoke(host,"repair-observation-ack",pin);
  await rm(execution,{recursive:true});
  expect(await invoke(host,"repair-source",pin)).toMatchObject({registered_repository_path:repository,execution_repository_path:execution,mode:"worktree"});
  expect(await invoke(host,"repair-workspace-version",pin)).toMatchObject({workspace_root:repository,workspace_version:expect.stringMatching(/^workspace-content-v1:/)});
  expect(await invoke(host,"execution-permission")).toEqual({allowed:false});
});

async function handoffTarget(){
 const [original]=z.array(z.object({observationId:z.string(),snapshotHash:z.string(),receiptHash:z.string(),attemptId:z.string()})).parse(await invoke({kind:"coordinator"},"repair-observations"));if(!original)throw new Error("Missing original fixture");
 const pin={case_id:"REPAIR-verified",observation_id:original.observationId,snapshot_hash:original.snapshotHash};await invoke(host,"repair-observation-ack",pin);
 const source=z.object({registered_repository_path:z.string(),execution_repository_path:z.string(),mode:z.enum(["in_place","worktree"])}).parse(await invoke(host,"repair-source",pin));
 return repairHandoffTargetSchema.parse({caseId:pin.case_id,verificationAttemptId:"verified-native-checks",sourceRepairAttemptId:"repair",sourcePreparationAttemptId:"independent-test",receiptHash:"a".repeat(64),inputHash:"b".repeat(64),nativeCandidateHash:"c".repeat(64),planHash:"d".repeat(64),expectedVersion:await readRepairWorkspaceVersion(repository),workspaceBinding:{workspaceId:human.workspaceId,issueId:human.issueId,projectId,runtimeId:randomUUID(),workspaceRoot:source.registered_repository_path,executionPath:source.execution_repository_path,mode:source.mode,sourceAttemptId:original.attemptId,snapshotHash:original.snapshotHash,targetsHash:"e".repeat(64)},originalObservationIds:[original.observationId],observationId:original.observationId,snapshotHash:original.snapshotHash,sourceReceiptHash:original.receiptHash});
}
for(const kind of ["direct","yaml"] as const)it(`prepares a replayable ${kind} successor without changing the surrendered checkpoint`,async()=>{
 if(kind==="direct"){await direct();await invoke(owner,"direct-run");}else{await invoke(human,"configure",{expected_revision:0,agent_id:agentId,repository_path:repository,sources:[{key:"original",kind:"acceptance",description:"Original entry",oracle:"Original observable behavior",sourceRef:"README.md"}]});await invoke({...owner,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});await invoke(owner,"start");}
 await invoke(owner,"intervention-request",body);
 await writeFile(join(repository,"README.md"),"Repaired source after independent verification");execFileSync("git",["-C",repository,"add","README.md"]);execFileSync("git",["-C",repository,"commit","-qm","Repaired fixture"]);
 const target=await handoffTarget();
 const before=new DatabaseSync(database),original=before.prepare("SELECT payload FROM engineering_intervention").get()!.payload,root=before.prepare(`SELECT payload FROM ${kind==="direct"?"direct_contract":"engineering_contract"}`).get()!.payload;before.close();
 const prepared=z.object({hash:z.string(),target_hash:z.string(),draft_id:z.string().nullable(),continuation:z.object({task_id:z.string(),agent_id:z.string(),user_id:z.string()})}).parse(await invoke(host,"repair-handoff-prepare",target));
 expect(prepared.continuation).toMatchObject({agent_id:agentId,user_id:human.userId});expect(prepared.continuation.task_id).not.toBe(owner.attemptId.split(":")[0]);
 app.close();app=new EngineeringApplication(database,definition);expect(await invoke(host,"repair-handoff-prepare",target)).toMatchObject(prepared);
 const check=new DatabaseSync(database),saved=handoffProposalSchema.parse(JSON.parse(String(check.prepare("SELECT payload FROM engineering_repair_handoff").get()!.payload)));
 expect(saved.checkpoint.kind).toBe(kind);expect(check.prepare("SELECT payload FROM engineering_intervention").get()!.payload).toBe(original);expect(check.prepare(`SELECT payload FROM ${kind==="direct"?"direct_contract":"engineering_contract"}`).get()!.payload).toBe(root);
 if(saved.checkpoint.kind==="yaml"){expect(saved.checkpoint.draft.binding.codeVersion).toBe(target.expectedVersion.split(":")[1]);expect(saved.checkpoint.draft.id).not.toBe(saved.checkpoint.originalDraftId);expect(check.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(saved.checkpoint.draft.id)).toBeUndefined();}
 check.close();expect(await invoke(host,"execution-permission")).toEqual({allowed:false});expect(await invoke({kind:"coordinator"},"continuations")).toEqual([]);
 const receipt=hostHandoffReservationFixture(target,await invoke(host,"repair-handoff-prepare",target));
 await expect(invoke(owner,"repair-handoff-stage",receipt)).rejects.toThrow(/Only the host/);
 const staged=await invoke(host,"repair-handoff-stage",receipt);expect(staged).toMatchObject({staged:true,hold_retained:true,reservation_hash:receipt.hash});
 app.close();app=new EngineeringApplication(database,definition);
 expect(await invoke(host,"repair-handoff-stage",receipt)).toEqual(staged);expect(await invoke(host,"repair-handoff-prepare",target)).toMatchObject(prepared);
 expect(await invoke(host,"repair-source",{case_id:target.caseId,observation_id:target.observationId,snapshot_hash:target.snapshotHash})).toMatchObject({checkpoint_state:"staged",attempt_id:owner.attemptId,handoff_target_hash:receipt.target_hash});
 const after=new DatabaseSync(database);expect(after.prepare("SELECT payload FROM engineering_intervention").get()!.payload).toBe(original);expect(after.prepare(`SELECT payload FROM ${kind==="direct"?"direct_contract":"engineering_contract"}`).get()!.payload).not.toBe(root);if(saved.checkpoint.kind==="yaml")expect(after.prepare("SELECT sequence FROM chain_drafts WHERE id=?").get(saved.checkpoint.draft.id)!.sequence).toBe(saved.checkpoint.draft.sequence);after.close();
 expect(await invoke(host,"execution-permission")).toEqual({allowed:false});expect(await invoke({kind:"coordinator"},"continuations")).toEqual([]);
 await expect(invoke(owner,"repair-handoff-prepare",target)).rejects.toThrow(/Only the host/);
 await writeFile(join(repository,"changed-after-preparation.txt"),"Changed candidate");await expect(invoke(host,"repair-handoff-prepare",target)).rejects.toThrow(/content changed/);
 if(kind==="yaml")await expect(invoke(host,"repair-handoff-prepare",{...target,expectedVersion:await readRepairWorkspaceVersion(repository)})).rejects.toThrow(/uncommitted/);
});
it("prepares Direct recovery from the frozen Team even after a newer Team profile is saved",async()=>{
 const teamId=randomUUID(),teamDb=new DatabaseSync(database),teams=new EngineeringTeamStore(teamDb);
 const definition={workflow:"direct" as const,roles:{executor:agentId},decision_mode:"balanced" as const,max_reworks:0};teams.configure(human.workspaceId,teamId,human.userId,{expected_revision:0,definition});
 await invoke(human,"team-start",{team_id:teamId,team_revision:1,project_id:projectId,input:"Original Team goal",repository_path:repository,execution_resources:[{path:repository,mode:"in_place"}]});
 await invoke({...owner,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});await invoke(owner,"direct-run");await invoke(owner,"intervention-request",body);
 teams.configure(human.workspaceId,teamId,human.userId,{expected_revision:1,definition:{...definition,roles:{executor:randomUUID()}}});teamDb.close();const target=await handoffTarget();
 expect(await invoke(host,"repair-handoff-prepare",target)).toMatchObject({continuation:{agent_id:agentId,user_id:human.userId}});
 const check=new DatabaseSync(database),prepared=handoffProposalSchema.parse(JSON.parse(String(check.prepare("SELECT payload FROM engineering_repair_handoff").get()!.payload)));expect(prepared.teamBinding?.profile.revision).toBe(1);check.close();
 const reservation=hostHandoffReservationFixture(target,await invoke(host,"repair-handoff-prepare",target));expect(await invoke(host,"repair-handoff-stage",reservation)).toMatchObject({staged:true,root_kind:"direct"});expect(await invoke(host,"team-binding")).toMatchObject({binding:{profile:{revision:1,definition:{roles:{executor:agentId}}}}});
});

it("preserves uncommitted in-place development while preparing its successor",async()=>{
 const development=await readFile(new URL("./definitions/development.yaml",import.meta.url),"utf8");app.close();app=new EngineeringApplication(database,definition,development);
 await invoke(human,"configure",{expected_revision:0,agent_id:randomUUID(),developer_agent_id:agentId,implementation_guidance:"Implement the original reader outcome",repository_path:repository,sources:[{key:"original",kind:"acceptance",description:"Original reader behavior",oracle:"Observe the original entry",sourceRef:"README.md"}]});
 await invoke({...owner,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});await invoke(owner,"start");await writeFile(join(repository,"partial-development.txt"),"Retain unfinished work");await invoke(owner,"intervention-request",body);
 const target=await handoffTarget();expect(await invoke(host,"repair-handoff-prepare",target)).toMatchObject({prepared:true,kind:"yaml",continuation:{agent_id:agentId}});
 const receipt=hostHandoffReservationFixture(target,await invoke(host,"repair-handoff-prepare",target));expect(await invoke(host,"repair-handoff-stage",receipt)).toMatchObject({staged:true,root_kind:"engineering"});
 expect(await readFile(join(repository,"partial-development.txt"),"utf8")).toBe("Retain unfinished work");expect(await invoke(host,"execution-permission")).toEqual({allowed:false});
});

it("rolls back a failed root write with its new draft and retries the same native reservation",async()=>{
 await invoke(human,"configure",{expected_revision:0,agent_id:agentId,repository_path:repository,sources:[{key:"original",kind:"acceptance",description:"Original reader behavior",oracle:"Observe the original entry",sourceRef:"README.md"}]});
 await invoke({...owner,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});await invoke(owner,"start");await invoke(owner,"intervention-request",body);
 const target=await handoffTarget(),receipt=hostHandoffReservationFixture(target,await invoke(host,"repair-handoff-prepare",target));
 const db=new DatabaseSync(database),root=db.prepare("SELECT payload FROM engineering_contract").get()!.payload;
 db.exec("CREATE TRIGGER fail_repair_stage BEFORE UPDATE ON engineering_contract BEGIN SELECT RAISE(ABORT,'fixture failed staging'); END");
 await expect(invoke(host,"repair-handoff-stage",receipt)).rejects.toThrow(/failed staging/);
 expect(db.prepare("SELECT payload FROM engineering_contract").get()!.payload).toBe(root);expect(db.prepare("SELECT count(*) AS n FROM chain_drafts").get()!.n).toBe(1);expect(db.prepare("SELECT count(*) AS n FROM engineering_repair_handoff_application").get()!.n).toBe(0);
 db.exec("DROP TRIGGER fail_repair_stage");expect(await invoke(host,"repair-handoff-stage",receipt)).toMatchObject({staged:true});db.close();
});
it("rejects an old asynchronous runtime bind after its recovery checkpoint is staged",async()=>{
 await invoke(human,"configure",{expected_revision:0,agent_id:agentId,repository_path:repository,sources:[{key:"original",kind:"acceptance",description:"Original reader behavior",oracle:"Observe the original entry",sourceRef:"README.md"}]});
 const daemon={...owner,kind:"daemon" as const};await invoke(daemon,"bind",{work_dir:repository,mode:"in_place",overlays:[]});await invoke(owner,"start");
 let release!:()=>void,entered!:()=>void;const pending=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 const validation=vi.spyOn(app as unknown as {validateDependencies:()=>Promise<void>},"validateDependencies").mockImplementationOnce(async()=>{entered();await pending;});
 const late=invoke(daemon,"bind",{work_dir:repository,mode:"in_place",overlays:[]});await started;
 try{
  await invoke(owner,"intervention-request",body);const target=await handoffTarget(),receipt=hostHandoffReservationFixture(target,await invoke(host,"repair-handoff-prepare",target));await invoke(host,"repair-handoff-stage",receipt);
  release();await expect(late).rejects.toThrow(/surrendered execution/);
  expect(await invoke(host,"repair-source",{case_id:target.caseId,observation_id:target.observationId,snapshot_hash:target.snapshotHash})).toMatchObject({checkpoint_state:"staged"});
 }finally{release();await late.catch(()=>{});validation.mockRestore();}
});
for(const kind of ["direct","yaml"] as const)it(`authorizes only the frozen ${kind} successor and resumes through its native bind`,async()=>{
 if(kind==="direct"){await direct();await invoke(owner,"direct-run");}else{await invoke(human,"configure",{expected_revision:0,agent_id:agentId,repository_path:repository,sources:[{key:"original",kind:"acceptance",description:"Original entry",oracle:"Original observable behavior",sourceRef:"README.md"}]});await invoke({...owner,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});await invoke(owner,"start");}
 await invoke(owner,"intervention-request",body);
 const target=await handoffTarget(),reservation=hostHandoffReservationFixture(target,await invoke(host,"repair-handoff-prepare",target)),application=await invoke(host,"repair-handoff-stage",reservation);
 await expect(invoke(owner,"repair-handoff-ready",application)).rejects.toThrow(/native host/);
 const ready=handoffReadySchema.parse(await invoke(host,"repair-handoff-ready",application));
 app.close();app=new EngineeringApplication(database,definition);expect(await invoke(host,"repair-handoff-ready",application)).toEqual(ready);
 expect(await invoke(host,"execution-permission")).toEqual({allowed:false});expect(await invoke(host,"execution-permission",{task_id:randomUUID()})).toEqual({allowed:false});expect(await invoke(host,"execution-permission",{task_id:ready.continuation.task_id})).toEqual({allowed:true});
 expect(await invoke({kind:"coordinator"},"continuations")).toEqual([]);await expect(invoke(human,"abandon",{})).rejects.toThrow(/surrendered/);
 const readinessPin={target_hash:ready.target_hash,application_hash:ready.application_hash,ready_hash:ready.hash};expect(await invoke(host,"repair-dispatch-readiness",readinessPin)).toMatchObject({state:"eligible",reason:"prepared-entry",task_id:ready.continuation.task_id});await expect(invoke(owner,"repair-dispatch-readiness",readinessPin)).rejects.toThrow(/native host/);
 const successor={...owner,attemptId:`${ready.continuation.task_id}:999999`};
 await expect(invoke(successor,kind==="direct"?"direct-run":"start")).rejects.toThrow(/surrendered/);
 await invoke({...successor,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});
 expect(await invoke(host,"execution-permission")).toEqual({allowed:true});
 await expect(invoke(owner,kind==="direct"?"direct-submit":"command",{})).rejects.toThrow(/surrendered/);
 await expect(invoke({...owner,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]})).rejects.toThrow(/surrendered/);
 if(kind==="direct"){await invoke(successor,"direct-run");await invoke(successor,"direct-submit",{summary:"Actual recovered result"});expect(await invoke(host,"completion")).toMatchObject({allowed:true});}
 else{
  const state=z.object({draft:z.object({id:z.string(),status:z.string(),phase:z.string().nullable(),attemptId:z.string()})}).parse(await invoke(successor,"start"));
  expect(state.draft).toMatchObject({id:handoffApplicationSchema.parse(application).draft_id,status:"editing",attemptId:successor.attemptId});
  const originalDb=new DatabaseSync(database),oldId=String(originalDb.prepare("SELECT draft_id FROM engineering_intervention").get()!.draft_id);originalDb.close();const drafts=new SqliteDraftStore(database);try{const old=await drafts.read(oldId);expect(old).toBeDefined();await expect(drafts.save({...old!,sequence:old!.sequence+1},old!.sequence)).rejects.toThrow(/Draft changed/);}finally{drafts.close();}
 }
 const db=new DatabaseSync(database);expect(db.prepare("SELECT state,attempt_id FROM engineering_repair_dispatch").get()).toMatchObject({state:"active",attempt_id:successor.attemptId});expect(db.prepare("SELECT count(*) AS n FROM engineering_intervention").get()!.n).toBe(1);db.close();
});
it("keeps dispatch held when the applied witness, candidate content or physical exit changes",async()=>{
 await direct();await invoke(owner,"direct-run");await invoke(owner,"intervention-request",body);
 const target=await handoffTarget(),reservation=hostHandoffReservationFixture(target,await invoke(host,"repair-handoff-prepare",target)),application=handoffApplicationSchema.parse(await invoke(host,"repair-handoff-stage",reservation));
 const {hash:_hash,...wrong}=application,changed={...wrong,reservation_hash:"f".repeat(64)};
 await expect(invoke(host,"repair-handoff-ready",{...changed,hash:handoffHash(changed)})).rejects.toThrow(/exact applied/);
 await writeFile(join(repository,"late-candidate.txt"),"Candidate changed after verification");await expect(invoke(host,"repair-handoff-ready",application)).rejects.toThrow(/content changed/);await rm(join(repository,"late-candidate.txt"));
 const db=new DatabaseSync(database);db.prepare("INSERT INTO engineering_process VALUES(?,?,?,?,?,?)").run(randomUUID(),human.workspaceId,human.issueId,owner.attemptId,"launching","{}");
 await expect(invoke(host,"repair-handoff-ready",application)).rejects.toThrow(/physical exit/);expect(db.prepare("SELECT count(*) AS n FROM engineering_repair_dispatch").get()!.n).toBe(0);expect(await invoke(host,"execution-permission")).toEqual({allowed:false});db.close();
});
async function recoveredProgress(kind:"direct"|"verification",bind=true){
 if(kind==="direct"){await direct();await invoke(owner,"direct-run");}else{await invoke(human,"configure",{expected_revision:0,agent_id:agentId,repository_path:repository,sources:[{key:"original",kind:"acceptance",description:"Original entry",oracle:"Title remains visible",sourceRef:"README.md"}]});await invoke({...owner,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});await invoke(owner,"start");}
 await invoke(owner,"intervention-request",body);const target=await handoffTarget(),reservation=hostHandoffReservationFixture(target,await invoke(host,"repair-handoff-prepare",target)),application=handoffApplicationSchema.parse(await invoke(host,"repair-handoff-stage",reservation)),ready=handoffReadySchema.parse(await invoke(host,"repair-handoff-ready",application));
 const successor={...owner,attemptId:`${ready.continuation.task_id}:999999`},daemon={...successor,kind:"daemon" as const},pin={target_hash:ready.target_hash,application_hash:ready.application_hash,ready_hash:ready.hash};
 expect(await invoke(host,"repair-business-progress",pin)).toEqual({progress:null});if(bind)await invoke(daemon,"bind",{work_dir:repository,mode:"in_place",overlays:[]});
 expect(await invoke(host,"repair-business-progress",pin)).toEqual({progress:null});
 return {successor,daemon,pin,application,ready};
}
async function finishRecoveredVerification(successor:ApplicationRequest["actor"]){
 let state=z.object({draft:draftSchema}).parse(await invoke(successor,"start"));const command=async(command:unknown)=>{state=z.object({draft:draftSchema}).parse(await invoke(successor,"command",{expected_sequence:state.draft.sequence,command}));};
 await command({type:"phase.complete"});await command({type:"artifact.put",ref:"verification.scenarios",key:"original",content:"channel: frontend\ntitle: Reader visible\nsetup: Open reader\nsteps: Reload reader\nexpected: Title remains visible\ncoverageRefs: [original]"});await command({type:"phase.complete"});await command({type:"artifact.put",ref:"verification.results",key:"original",content:"status: passed\nevidence: Controlled reader observation"});await command({type:"phase.complete"});await command({type:"artifact.put",ref:"verification.evidence-review",content:"summary: Compared new observations against the frozen Expected"});await command({type:"phase.complete"});await command({type:"phase.complete"});return state.draft;
}
for(const kind of ["direct","verification"] as const)it(`observes only the new normally applied ${kind} result and retains its immutable proof across restart`,async()=>{
 const h=await recoveredProgress(kind);await expect(invoke(h.successor,"repair-business-progress",h.pin)).rejects.toThrow(/native host/);
 if(kind==="direct"){await invoke(h.successor,"direct-run");expect(await invoke(host,"repair-business-progress",h.pin)).toEqual({progress:null});await invoke(h.successor,"direct-submit",{summary:"New ordinary recovered result"});}else await finishRecoveredVerification(h.successor);
 const first=z.object({progress:repairBusinessProgressSchema}).parse(await invoke(host,"repair-business-progress",h.pin));expect(first.progress).toMatchObject({applied:true,attempt_id:h.successor.attemptId,task_id:h.ready.continuation.task_id,chain:kind,application_hash:h.application.hash});expect(first.progress.result_hash).toMatch(/^[a-f0-9]{64}$/);
 app.close();app=new EngineeringApplication(database,definition);expect(await invoke(host,"repair-business-progress",h.pin)).toEqual(first);
 const db=new DatabaseSync(database);expect(db.prepare("SELECT payload FROM engineering_repair_business_progress").get()!.payload).toBe(JSON.stringify(first.progress));
 if(kind==="direct"){db.prepare("UPDATE direct_contract SET payload=json_set(payload,'$.result.summary','Forged result')").run();await expect(invoke(host,"repair-business-progress",h.pin)).rejects.toThrow(/result changed/);}
 else{db.prepare("UPDATE chain_drafts SET payload=json_set(payload,'$.events[#-1].command','phase.rewind') WHERE id=?").run(first.progress.draft_id);await expect(invoke(host,"repair-business-progress",h.pin)).rejects.toThrow(/ordinary completion event/);}
 expect(db.prepare("SELECT payload FROM engineering_repair_business_progress").get()!.payload).toBe(JSON.stringify(first.progress));db.close();
});
it("retains observation while this recovery's provider exit is unknown and allows later normal work on the same issue",async()=>{
 const h=await recoveredProgress("direct");await invoke(h.successor,"direct-run");await invoke(h.successor,"direct-submit",{summary:"New result"});const db=new DatabaseSync(database),id=randomUUID();
 db.prepare("INSERT INTO engineering_process VALUES(?,?,?,?,?,?)").run(id,human.workspaceId,human.issueId,h.successor.attemptId,"launching","{}");expect(await invoke(host,"repair-business-progress",h.pin)).toEqual({progress:null});db.prepare("UPDATE engineering_process SET status='exited' WHERE allocation_id=?").run(id);
 db.prepare("INSERT INTO engineering_process VALUES(?,?,?,?,?,?)").run(randomUUID(),human.workspaceId,human.issueId,`${randomUUID()}:777777`,"running","{}");expect(await invoke(host,"repair-business-progress",h.pin)).toMatchObject({progress:{applied:true,attempt_id:h.successor.attemptId}});db.close();
});
it("refuses a completed draft before its normal owner applies the result",async()=>{
 const h=await recoveredProgress("verification");await finishRecoveredVerification(h.successor);const db=new DatabaseSync(database),root=String(db.prepare("SELECT payload FROM engineering_contract").get()!.payload),value=JSON.parse(root);delete value.verificationExecution;db.prepare("UPDATE engineering_contract SET payload=?").run(JSON.stringify(value));
 expect(await invoke(host,"repair-business-progress",h.pin)).toEqual({progress:null});expect(db.prepare("SELECT count(*) AS n FROM engineering_repair_business_progress").get()!.n).toBe(0);db.prepare("UPDATE engineering_contract SET payload=?").run(root);expect(await invoke(host,"repair-business-progress",h.pin)).toMatchObject({progress:{applied:true}});db.close();
});
it("observes the actual replacement claim after a pre-result native reclaim of the same recovery task",async()=>{
 const h=await recoveredProgress("direct"),replacement={...h.successor,attemptId:`${h.ready.continuation.task_id}:1000000`},db=new DatabaseSync(database),id=randomUUID();
 db.prepare("INSERT INTO engineering_process VALUES(?,?,?,?,?,?)").run(id,human.workspaceId,human.issueId,h.successor.attemptId,"launching","{}");await expect(invoke({...replacement,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]})).rejects.toThrow(/physical exit/);db.prepare("UPDATE engineering_process SET status='exited' WHERE allocation_id=?").run(id);
 await invoke({...replacement,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});await invoke(replacement,"direct-run");await invoke(replacement,"direct-submit",{summary:"Actual replacement result"});expect(await invoke(host,"repair-business-progress",h.pin)).toMatchObject({progress:{attempt_id:replacement.attemptId,task_id:h.ready.continuation.task_id}});expect(db.prepare("SELECT attempt_id FROM engineering_repair_dispatch").get()!.attempt_id).toBe(replacement.attemptId);db.close();
});
it("permanently rejects a recovery writer that read before native claim replacement",async()=>{
 const h=await recoveredProgress("verification"),old=z.object({draft:draftSchema}).parse(await invoke(h.successor,"start")).draft,replacement={...h.successor,attemptId:`${h.ready.continuation.task_id}:1000001`},drafts=new SqliteDraftStore(database);
 try{
  await invoke({...replacement,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});
  await expect(drafts.save({...old,sequence:old.sequence+1},old.sequence)).rejects.toThrow(/Draft changed/);await expect(invoke(h.successor,"command",{expected_sequence:old.sequence,command:{type:"phase.complete"}})).rejects.toThrow(/claim was replaced/);await expect(invoke({...h.successor,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]})).rejects.toThrow(/claim was replaced/);
  await expect(invoke({...h.successor,kind:"daemon"},"process",{operation:"reserve",allocation_id:randomUUID(),runtime_id:randomUUID(),host_id:"retired-native",provider:"codex"})).rejects.toThrow(/Surrendered/);
  await finishRecoveredVerification(replacement);expect(await invoke(host,"repair-business-progress",h.pin)).toMatchObject({progress:{attempt_id:replacement.attemptId}});
 }finally{drafts.close();}
});

it("continues a repaired draft through an authenticated human answer and a fresh native task",async()=>{
 const h=await recoveredProgress("verification");let state=z.object({draft:draftSchema}).parse(await invoke(h.successor,"start"));
 const command=async(command:unknown)=>{state=z.object({draft:draftSchema}).parse(await invoke(h.successor,"command",{expected_sequence:state.draft.sequence,command}));};
 await command({type:"phase.complete"});await command({type:"runtime-input.put",key:"entry",title:"Test entry",question:"Which entry?",why:"Need a real entry",recommendation:"Use the local fixture"});await command({type:"phase.complete"});
 const checkpoint=()=>({expected_revision:1,expected_sequence:state.draft.sequence});
 await expect(invoke(human,"prepare-run",checkpoint())).rejects.toThrow(/every pending question/);
 state=z.object({draft:draftSchema}).parse(await invoke(human,"answer",{expected_sequence:state.draft.sequence,request_id:state.draft.runtimeInputs[0]!.id,answer:"Use the isolated local entry"}));
 const selected=z.object({recovery_execution:repairExecutionHintSchema}).parse(await invoke(human,"prepare-run",checkpoint())),hint=selected.recovery_execution;
 expect(hint).toMatchObject({kind:"continuation",entry_task_id:h.ready.continuation.task_id,draft_id:state.draft.id,sequence:state.draft.sequence});
 const next={...h.successor,attemptId:`${randomUUID()}:1111111`},daemon={...next,kind:"daemon" as const},bind={work_dir:repository,mode:"in_place",overlays:[]};
 await expect(invoke(daemon,"bind",bind)).rejects.toThrow(/continuation context/);
 const wrong={...hint,draft_id:randomUUID()};await expect(app.invoke({actor:daemon,action:"bind",payload:bind,recovery_execution:{...wrong,hash:repairExecutionHintHash(wrong)}})).rejects.toThrow(/host-prepared hint/);
 const db=new DatabaseSync(database),allocation=randomUUID();db.prepare("INSERT INTO engineering_process VALUES(?,?,?,?,?,?)").run(allocation,human.workspaceId,human.issueId,h.successor.attemptId,"running","{}");
 await expect(app.invoke({actor:daemon,action:"bind",payload:bind,recovery_execution:hint})).rejects.toThrow(/physical exit/);db.prepare("UPDATE engineering_process SET status='exited' WHERE allocation_id=?").run(allocation);
 await app.invoke({actor:daemon,action:"bind",payload:bind,recovery_execution:hint});await expect(invoke(h.successor,"start")).rejects.toThrow(/replaced/);
 state=z.object({draft:draftSchema}).parse(await invoke(next,"start"));
 const finish=async(command:unknown)=>{state=z.object({draft:draftSchema}).parse(await invoke(next,"command",{expected_sequence:state.draft.sequence,command}));};
 await finish({type:"artifact.put",ref:"verification.scenarios",key:"original",content:"channel: frontend\ntitle: Reader visible\nsetup: Open reader\nsteps: Reload reader\nexpected: Title remains visible\ncoverageRefs: [original]"});await finish({type:"phase.complete"});await finish({type:"artifact.put",ref:"verification.results",key:"original",content:"status: passed\nevidence: Controlled new observation"});await finish({type:"phase.complete"});await finish({type:"artifact.put",ref:"verification.evidence-review",content:"summary: Compared the new result with frozen Expected"});await finish({type:"phase.complete"});await finish({type:"phase.complete"});
 const observed=await invoke(host,"repair-business-progress",h.pin);expect(observed).toMatchObject({progress:{task_id:next.attemptId.split(":")[0],entry_task_id:h.ready.continuation.task_id,execution_hint_hash:hint.hash,attempt_id:next.attemptId,draft_id:state.draft.id}});
 app.close();app=new EngineeringApplication(database,definition);expect(await invoke(host,"repair-business-progress",h.pin)).toEqual(observed);db.close();
});

it("links a human-restarted Direct recovery to its actual new native task without inheriting a result",async()=>{
 const h=await recoveredProgress("direct");await invoke(h.successor,"direct-run");const overview=z.object({revision:z.number(),sequence:z.number()}).parse(await invoke(human,"overview")),hint=z.object({recovery_execution:repairExecutionHintSchema}).parse(await invoke(human,"prepare-run",{expected_revision:overview.revision,expected_sequence:overview.sequence})).recovery_execution;
 expect(hint).toMatchObject({kind:"continuation",draft_id:null,entry_task_id:h.ready.continuation.task_id});const next={...h.successor,attemptId:`${randomUUID()}:1111111`};await app.invoke({actor:{...next,kind:"daemon"},action:"bind",payload:{work_dir:repository,mode:"in_place",overlays:[]},recovery_execution:hint});await invoke(next,"direct-run");await invoke(next,"direct-submit",{summary:"Fresh Direct result"});expect(await invoke(host,"repair-business-progress",h.pin)).toMatchObject({progress:{task_id:next.attemptId.split(":")[0],entry_task_id:h.ready.continuation.task_id,execution_hint_hash:hint.hash,chain:"direct",draft_id:null}});
});

for(const kind of ["direct","verification"] as const)it(`freezes a failed ${kind} recovery before any Agent view and can prepare another repair without changing prior evidence`,async()=>{
 const h=await recoveredProgress(kind),db=new DatabaseSync(database),before=db.prepare("SELECT payload FROM engineering_intervention").get()!.payload;
 expect(db.prepare("SELECT count(*) AS n FROM engineering_intervention_view WHERE attempt_id=?").get(h.successor.attemptId)!.n).toBe(0);
 const source=z.object({checkpoint:z.record(z.string(),z.unknown()),reason:z.literal("editable")}).parse(await invoke(host,"repair-recovery-checkpoint",h.pin)),native=recoveryFault(source.checkpoint),staleHint=z.object({recovery_execution:repairExecutionHintSchema}).parse(await invoke(human,"prepare-run",{expected_revision:source.checkpoint.revision,expected_sequence:source.checkpoint.sequence})).recovery_execution;
 const allocation=randomUUID();db.prepare("INSERT INTO engineering_process VALUES(?,?,?,?,?,?)").run(allocation,human.workspaceId,human.issueId,h.successor.attemptId,"running","{}");
 await expect(invoke(h.successor,"repair-recovery-hold",{...h.pin,native})).rejects.toThrow(/native host/);
 const held=z.object({held:z.object({observationId:z.string(),snapshotHash:z.string(),attemptId:z.string(),draftId:z.string().nullable(),phase:z.string(),recovery:repairRecoveryFaultSchema,snapshot:z.record(z.string(),z.unknown())}).passthrough()}).parse(await app.invoke({actor:host,action:"repair-recovery-hold",payload:{...h.pin,native},host_version:"sha256:"+"a".repeat(64)})).held;
 expect(held).toMatchObject({attemptId:h.successor.attemptId,recovery:native});expect(db.prepare("SELECT count(*) AS n FROM engineering_intervention").get()!.n).toBe(2);expect(db.prepare("SELECT payload FROM engineering_intervention WHERE attempt_id=?").get(owner.attemptId)!.payload).toBe(before);
 expect(db.prepare("SELECT status FROM engineering_process WHERE allocation_id=?").get(allocation)!.status).toBe("running");expect(await invoke(host,"execution-permission")).toEqual({allowed:false});await expect(invoke(h.successor,kind==="direct"?"direct-run":"start")).rejects.toThrow(/surrendered/);
 if(kind==="direct"){expect(held.phase).toBe("bound");expect(z.object({direct:z.object({attempts:z.array(z.object({id:z.string(),run_at:z.string().nullable()}))})}).parse(held.snapshot).direct.attempts.find(item=>item.id===h.successor.attemptId)!.run_at).toBeNull();}
 else{const draft=draftSchema.parse(held.snapshot.draft);expect(draft.attemptId).not.toBe(h.successor.attemptId);expect(draft.events.at(-1)!.command).toBe("host.repair.prepare");}
 app.close();app=new EngineeringApplication(database,definition);expect(await invoke(host,"repair-recovery-checkpoint",h.pin)).toMatchObject({reason:"held",held});expect(await app.invoke({actor:host,action:"repair-recovery-hold",payload:{...h.pin,native}})).toEqual({held});
 expect(await invoke({kind:"coordinator"},"repair-observations")).toEqual([held]);await invoke(host,"repair-observation-ack",{case_id:native.case_id,observation_id:held.observationId,snapshot_hash:held.snapshotHash});expect(await invoke({kind:"coordinator"},"repair-observations")).toEqual([]);
 const newPin={case_id:native.case_id,observation_id:held.observationId,snapshot_hash:held.snapshotHash};expect(await invoke(host,"repair-source",newPin)).toMatchObject({attempt_id:h.successor.attemptId,case_id:native.case_id});
 const {hostHandoffTargetFixture}=await import("./test-helpers/repair-handoff-fixture"),target=await hostHandoffTargetFixture(held,{...human,projectId,repositoryPath:repository,caseId:native.case_id});
 target.verificationAttemptId=`verified-again-${randomUUID()}`;target.workspaceBinding.runtimeId=native.runtime_id;target.originalObservationIds=[JSON.parse(String(before)).observationId,held.observationId];
 db.prepare("UPDATE engineering_process SET status='exited' WHERE allocation_id=?").run(allocation);
 const prepared=await invoke(host,"repair-handoff-prepare",target),reservation=hostHandoffReservationFixture(target,prepared),application=await invoke(host,"repair-handoff-stage",reservation),ready=handoffReadySchema.parse(await invoke(host,"repair-handoff-ready",application)),next={...owner,attemptId:`${ready.continuation.task_id}:2222222`};
 expect(ready.continuation.task_id).not.toBe(h.ready.continuation.task_id);await invoke({...next,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});
 await expect(app.invoke({actor:{...next,kind:"daemon",attemptId:`${randomUUID()}:3333333`},action:"bind",payload:{work_dir:repository,mode:"in_place",overlays:[]},recovery_execution:staleHint})).rejects.toThrow(/surrendered.*later repair/);const current=z.object({revision:z.number(),sequence:z.number()}).parse(await invoke(human,"overview"));expect(await invoke(human,"prepare-run",{expected_revision:current.revision,expected_sequence:current.sequence})).toMatchObject({recovery_execution:{target_hash:ready.target_hash,entry_task_id:ready.continuation.task_id}});
 if(kind==="direct"){await invoke(next,"direct-run");await invoke(next,"direct-submit",{summary:"Second independently repaired ordinary result"});}else await finishRecoveredVerification(next);
 expect(await invoke(host,"repair-business-progress",{target_hash:ready.target_hash,application_hash:ready.application_hash,ready_hash:ready.hash})).toMatchObject({progress:{applied:true,attempt_id:next.attemptId}});expect(db.prepare("SELECT count(*) AS n FROM engineering_intervention").get()!.n).toBe(2);db.close();
});
it("refuses stale recovery checkpoint holds and excludes human questions and completed ordinary work",async()=>{
 const h=await recoveredProgress("verification"),initial=z.object({checkpoint:z.record(z.string(),z.unknown())}).parse(await invoke(host,"repair-recovery-checkpoint",h.pin)),native=recoveryFault(initial.checkpoint);
 for(const changed of [{...native,case_id:"another-case"},{...native,project_id:randomUUID()},{...native,execution_hint_hash:"c".repeat(64)}])await expect(invoke(host,"repair-recovery-hold",{...h.pin,native:{...changed,hash:repairRecoveryFaultHash(changed)}})).rejects.toThrow(/changed before/);
 let state=z.object({draft:draftSchema}).parse(await invoke(h.successor,"start"));
 await expect(invoke(host,"repair-recovery-hold",{...h.pin,native})).rejects.toThrow(/changed before/);const db=new DatabaseSync(database);expect(db.prepare("SELECT count(*) AS n FROM engineering_intervention").get()!.n).toBe(1);
 const command=async(command:unknown)=>{state=z.object({draft:draftSchema}).parse(await invoke(h.successor,"command",{expected_sequence:state.draft.sequence,command}));};await command({type:"phase.complete"});await command({type:"runtime-input.put",key:"entry",title:"Entry",question:"Which entry?",why:"Need real input",recommendation:"Use isolated entry"});await command({type:"phase.complete"});
 expect(await invoke(host,"repair-dispatch-readiness",h.pin)).toMatchObject({state:"waiting",reason:"human-answers-pending"});expect(await invoke(host,"repair-recovery-checkpoint",h.pin)).toEqual({checkpoint:null,reason:"waiting-for-answers"});await expect(invoke(host,"repair-recovery-hold",{...h.pin,native})).rejects.toThrow(/changed before/);db.close();
});

it("captures recovery provenance through the bundled private worker without recording an Agent view or RUN",async()=>{
 const h=await recoveredProgress("direct"),worker=new URL("./dist/worker.mjs",import.meta.url).pathname;app.close();
 try{
  const call=(action:ApplicationRequest["action"],payload:unknown)=>JSON.parse(execFileSync(process.execPath,[worker,database],{encoding:"utf8",stdio:["pipe","pipe","ignore"],input:JSON.stringify({actor:host,action,payload,host_version:"sha256:"+"a".repeat(64)})}));
  const source=z.object({result:z.object({checkpoint:z.record(z.string(),z.unknown())})}).parse(call("repair-recovery-checkpoint",h.pin)),native=recoveryFault(source.result.checkpoint),reply=z.object({result:z.object({held:z.object({observationId:z.string(),kernelVersion:z.string(),hostVersion:z.string(),recovery:repairRecoveryFaultSchema})})}).parse(call("repair-recovery-hold",{...h.pin,native}));
  expect(reply.result.held.kernelVersion).toBe(`sha256:${createHash("sha256").update(await readFile(worker)).digest("hex")}`);expect(reply.result.held.hostVersion).toBe("sha256:"+"a".repeat(64));expect(reply.result.held.recovery).toEqual(native);const db=new DatabaseSync(database);expect(db.prepare("SELECT count(*) AS n FROM engineering_intervention_view WHERE attempt_id=?").get(h.successor.attemptId)!.n).toBe(0);db.close();
 }finally{app=new EngineeringApplication(database,definition);}
 expect(await invoke(host,"execution-permission")).toEqual({allowed:false});
});

for(const kind of ["direct","verification"] as const)it(`surrenders an unbound ${kind} preparation with retained provenance and resumes only a separately verified generation`,async()=>{
 const h=await recoveredProgress(kind,false),db=new DatabaseSync(database),previous=String(db.prepare("SELECT payload FROM engineering_intervention").get()!.payload),hintRow=db.prepare("SELECT payload FROM engineering_repair_execution_hint WHERE target_hash=?").get(h.ready.target_hash)!;
 const staleHint=repairExecutionHintSchema.parse(JSON.parse(String(hintRow.payload)));
 const source=z.object({checkpoint:z.record(z.string(),z.unknown()),reason:z.literal("prepared")}).parse(await invoke(host,"repair-recovery-checkpoint",h.pin));expect(source.checkpoint.attempt_id).toBeNull();
 const native=recoveryFault(source.checkpoint,h.successor.attemptId),held=z.object({held:z.object({observationId:z.string(),snapshotHash:z.string(),recovery:repairRecoveryFaultSchema}).passthrough()}).parse(await app.invoke({actor:host,action:"repair-recovery-hold",payload:{...h.pin,native},host_version:"sha256:"+"a".repeat(64)})).held;
 expect(held.recovery.preparation).toMatchObject({source_attempt_id:owner.attemptId});expect(db.prepare("SELECT payload FROM engineering_intervention WHERE attempt_id=?").get(owner.attemptId)!.payload).toBe(previous);
 expect(db.prepare("SELECT count(*) AS n FROM engineering_process_binding WHERE attempt_id=?").get(h.successor.attemptId)!.n).toBe(0);expect(db.prepare("SELECT count(*) AS n FROM engineering_intervention_view WHERE attempt_id=?").get(h.successor.attemptId)!.n).toBe(0);expect(db.prepare("SELECT state,attempt_id FROM engineering_repair_dispatch WHERE target_hash=?").get(h.ready.target_hash)).toMatchObject({state:"ready",attempt_id:null});
 expect(await invoke(host,"execution-permission",{task_id:h.ready.continuation.task_id})).toEqual({allowed:false});await expect(invoke(h.daemon,"bind",{work_dir:repository,mode:"in_place",overlays:[]})).rejects.toThrow(/surrendered/);
 app.close();app=new EngineeringApplication(database,definition);expect(await invoke(host,"repair-recovery-checkpoint",h.pin)).toMatchObject({reason:"held",held});expect(await invoke(host,"repair-recovery-hold",{...h.pin,native})).toEqual({held});
 const newPin={case_id:native.case_id,observation_id:held.observationId,snapshot_hash:held.snapshotHash};await invoke(host,"repair-observation-ack",newPin);expect(await invoke({kind:"coordinator"},"repair-observations")).toEqual([]);
 expect(await invoke(host,"repair-source",newPin)).toMatchObject({checkpoint_state:"prepared",attempt_id:h.successor.attemptId,execution_binding_origin:"retained-preparation",execution_source_attempt_id:owner.attemptId,registered_repository_path:repository});
 expect(await invoke(host,"repair-workspace-version",newPin)).toMatchObject({source_attempt_id:h.successor.attemptId,workspace_root:repository});
 const {hostHandoffTargetFixture}=await import("./test-helpers/repair-handoff-fixture"),target=await hostHandoffTargetFixture(held,{...human,projectId,repositoryPath:repository,caseId:native.case_id});target.verificationAttemptId=`verified-prebind-${randomUUID()}`;target.workspaceBinding.runtimeId=native.runtime_id;target.originalObservationIds=[JSON.parse(previous).observationId,held.observationId];
 const proposal=await invoke(host,"repair-handoff-prepare",target),reservation=hostHandoffReservationFixture(target,proposal),application=await invoke(host,"repair-handoff-stage",reservation);let ready=handoffReadySchema.parse(await invoke(host,"repair-handoff-ready",application));
 if(kind==="direct"){
  const secondPin={target_hash:ready.target_hash,application_hash:ready.application_hash,ready_hash:ready.hash},secondSource=z.object({checkpoint:z.record(z.string(),z.unknown())}).parse(await invoke(host,"repair-recovery-checkpoint",secondPin)),secondNative=recoveryFault(secondSource.checkpoint,`${ready.continuation.task_id}:2222221`),secondHeld=z.object({held:z.object({observationId:z.string(),snapshotHash:z.string()}).passthrough()}).parse(await invoke(host,"repair-recovery-hold",{...secondPin,native:secondNative})).held;
  const secondAck={case_id:native.case_id,observation_id:secondHeld.observationId,snapshot_hash:secondHeld.snapshotHash};await invoke(host,"repair-observation-ack",secondAck);expect(await invoke(host,"repair-source",secondAck)).toMatchObject({attempt_id:secondNative.attempt_id,execution_source_attempt_id:owner.attemptId});
  const thirdTarget=await hostHandoffTargetFixture(secondHeld,{...human,projectId,repositoryPath:repository,caseId:native.case_id});thirdTarget.verificationAttemptId=`verified-third-${randomUUID()}`;thirdTarget.workspaceBinding.runtimeId=native.runtime_id;const thirdReservation=hostHandoffReservationFixture(thirdTarget,await invoke(host,"repair-handoff-prepare",thirdTarget)),thirdApplication=await invoke(host,"repair-handoff-stage",thirdReservation);ready=handoffReadySchema.parse(await invoke(host,"repair-handoff-ready",thirdApplication));
 }
 const next={...owner,attemptId:`${ready.continuation.task_id}:2222222`};
 await invoke({...next,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});await expect(app.invoke({actor:{...next,kind:"daemon",attemptId:`${randomUUID()}:3333333`},action:"bind",payload:{work_dir:repository,mode:"in_place",overlays:[]},recovery_execution:staleHint})).rejects.toThrow(/surrendered.*later repair/);
 if(kind==="direct"){await invoke(next,"direct-run");await invoke(next,"direct-submit",{summary:"Ordinary result after prepared failure"});}else await finishRecoveredVerification(next);
 expect(await invoke(host,"repair-business-progress",{target_hash:ready.target_hash,application_hash:ready.application_hash,ready_hash:ready.hash})).toMatchObject({progress:{applied:true,attempt_id:next.attemptId}});expect(db.prepare("SELECT count(*) AS n FROM engineering_process_binding WHERE attempt_id=?").get(h.successor.attemptId)!.n).toBe(0);db.close();
});
it("atomically retains prepared admission when its fault provenance or outbox insertion fails",async()=>{
 const h=await recoveredProgress("direct",false),db=new DatabaseSync(database),source=z.object({checkpoint:z.record(z.string(),z.unknown())}).parse(await invoke(host,"repair-recovery-checkpoint",h.pin)),native=recoveryFault(source.checkpoint,h.successor.attemptId);
 const {repairRecoveryFaultHash}=await import("./repair-recovery-fault"),changed={...native,preparation:{...native.preparation!,source_attempt_id:`${randomUUID()}:1`}};changed.hash=repairRecoveryFaultHash(changed);await expect(invoke(host,"repair-recovery-hold",{...h.pin,native:changed})).rejects.toThrow(/changed before/);
 db.exec("CREATE TRIGGER fail_prebind_outbox BEFORE INSERT ON engineering_intervention BEGIN SELECT RAISE(ABORT,'fixture failed outbox'); END");await expect(invoke(host,"repair-recovery-hold",{...h.pin,native})).rejects.toThrow(/failed outbox/);expect(db.prepare("SELECT count(*) AS n FROM engineering_repair_prebind").get()!.n).toBe(0);expect(await invoke(host,"execution-permission",{task_id:h.ready.continuation.task_id})).toEqual({allowed:true});db.exec("DROP TRIGGER fail_prebind_outbox");expect(await invoke(host,"repair-recovery-hold",{...h.pin,native})).toHaveProperty("held");db.close();
});

it("upgrades the original pending view without losing its held source or opening prepared admission",async()=>{
 const h=await recoveredProgress("direct",false),db=new DatabaseSync(database),before=String(db.prepare("SELECT payload FROM engineering_intervention").get()!.payload);app.close();
 db.exec("DROP VIEW engineering_intervention_pending;DROP TABLE engineering_repair_prebind;CREATE VIEW engineering_intervention_pending AS SELECT original.* FROM engineering_intervention original WHERE NOT EXISTS(SELECT 1 FROM engineering_repair_dispatch dispatch WHERE dispatch.observation_id=json_extract(original.payload,'$.observationId') AND dispatch.state='active')");app=new EngineeringApplication(database,definition);
 expect(String(db.prepare("SELECT payload FROM engineering_intervention_pending").get()!.payload)).toBe(before);expect(await invoke(host,"execution-permission")).toEqual({allowed:false});expect(await invoke(host,"execution-permission",{task_id:h.ready.continuation.task_id})).toEqual({allowed:true});const source=z.object({checkpoint:z.record(z.string(),z.unknown())}).parse(await invoke(host,"repair-recovery-checkpoint",h.pin));expect(await invoke(host,"repair-recovery-hold",{...h.pin,native:recoveryFault(source.checkpoint,h.successor.attemptId)})).toHaveProperty("held");db.close();
});

for(const kind of ["direct","verification"] as const)it(`holds a never-claimed ${kind} dispatch without inventing an execution and resumes only a verified new generation`,async()=>{
 const h=await recoveredProgress(kind,false),db=new DatabaseSync(database),prior=String(db.prepare("SELECT payload FROM engineering_intervention").get()!.payload),source=z.object({checkpoint:z.record(z.string(),z.unknown())}).parse(await invoke(host,"repair-recovery-checkpoint",h.pin)),{hostDispatchStallFixture,hostHandoffTargetFixture}=await import("./test-helpers/repair-handoff-fixture"),native=await hostDispatchStallFixture(source.checkpoint),staleHint=repairExecutionHintSchema.parse(JSON.parse(String(db.prepare("SELECT payload FROM engineering_repair_execution_hint WHERE target_hash=?").get(h.ready.target_hash)!.payload)));
 const held=z.object({held:z.object({observationId:z.string(),snapshotHash:z.string(),attemptId:z.string(),sourceKind:z.literal("prepared-dispatch"),dispatchStall:z.unknown()}).passthrough()}).parse(await invoke(host,"repair-dispatch-hold",{...h.pin,native})).held;
 expect(held.attemptId).toBe(owner.attemptId);expect(held.dispatchStall).toMatchObject({task_id:h.ready.continuation.task_id,claimed_at:null,started_at:null});expect(db.prepare("SELECT payload FROM engineering_intervention").get()!.payload).toBe(prior);expect(db.prepare("SELECT count(*) AS n FROM engineering_dispatch_intervention").get()!.n).toBe(1);expect(db.prepare("SELECT count(*) AS n FROM engineering_process_binding WHERE attempt_id LIKE ?").get(h.ready.continuation.task_id+":%")!.n).toBe(0);expect(await invoke(host,"execution-permission",{task_id:h.ready.continuation.task_id})).toEqual({allowed:false});
 app.close();app=new EngineeringApplication(database,definition);expect(await invoke(host,"repair-dispatch-hold",{...h.pin,native})).toEqual({held});expect(await invoke({kind:"coordinator"},"repair-observations")).toEqual([held]);const ack={case_id:native.case_id,observation_id:held.observationId,snapshot_hash:held.snapshotHash};await invoke(host,"repair-observation-ack",ack);expect(await invoke(host,"repair-source",ack)).toMatchObject({attempt_id:owner.attemptId,dispatch_task_id:native.task_id,dispatch_hold_hash:native.hash,execution_source_attempt_id:owner.attemptId});
 const target=await hostHandoffTargetFixture(held,{...human,projectId,repositoryPath:repository,caseId:native.case_id});target.verificationAttemptId=`verified-stall-${randomUUID()}`;target.workspaceBinding.runtimeId=native.runtime_id;const reservation=hostHandoffReservationFixture(target,await invoke(host,"repair-handoff-prepare",target)),application=await invoke(host,"repair-handoff-stage",reservation),ready=handoffReadySchema.parse(await invoke(host,"repair-handoff-ready",application)),next={...owner,attemptId:`${ready.continuation.task_id}:2222222`};await invoke({...next,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});
 await expect(app.invoke({actor:{...next,kind:"daemon",attemptId:`${h.ready.continuation.task_id}:3333333`},action:"bind",payload:{work_dir:repository,mode:"in_place",overlays:[]},recovery_execution:staleHint})).rejects.toThrow(/surrendered.*later repair/);
 if(kind==="verification"){const drafts=new SqliteDraftStore(database);try{const stale=await drafts.read(String(source.checkpoint.draft_id));expect(stale).toBeDefined();await expect(drafts.save({...stale!,sequence:stale!.sequence+1},stale!.sequence)).rejects.toThrow(/Draft changed/);}finally{drafts.close();}}
 if(kind==="direct"){await invoke(next,"direct-run");await invoke(next,"direct-submit",{summary:"Ordinary result after dispatch recovery"});}else await finishRecoveredVerification(next);expect(await invoke(host,"repair-business-progress",{target_hash:ready.target_hash,application_hash:ready.application_hash,ready_hash:ready.hash})).toMatchObject({progress:{applied:true,attempt_id:next.attemptId}});expect(db.prepare("SELECT count(*) AS n FROM engineering_process_binding WHERE attempt_id LIKE ?").get(native.task_id+":%")!.n).toBe(0);db.close();
});
it("rolls back dispatch supersession if its outbox cannot be persisted",async()=>{
 const h=await recoveredProgress("direct",false),db=new DatabaseSync(database),source=z.object({checkpoint:z.record(z.string(),z.unknown())}).parse(await invoke(host,"repair-recovery-checkpoint",h.pin)),{hostDispatchStallFixture}=await import("./test-helpers/repair-handoff-fixture"),native=await hostDispatchStallFixture(source.checkpoint);db.exec("CREATE TRIGGER fail_dispatch_outbox BEFORE INSERT ON engineering_dispatch_intervention BEGIN SELECT RAISE(ABORT,'fixture failed dispatch outbox'); END");await expect(invoke(host,"repair-dispatch-hold",{...h.pin,native})).rejects.toThrow(/failed dispatch outbox/);expect(db.prepare("SELECT count(*) AS n FROM engineering_repair_prebind").get()!.n).toBe(0);expect(await invoke(host,"execution-permission",{task_id:native.task_id})).toEqual({allowed:true});db.exec("DROP TRIGGER fail_dispatch_outbox");expect(await invoke(host,"repair-dispatch-hold",{...h.pin,native})).toHaveProperty("held");db.close();
});
it("captures a dispatch hold through the bundled worker with actual host/kernel versions",async()=>{
 const h=await recoveredProgress("direct",false),worker=new URL("./dist/worker.mjs",import.meta.url).pathname;app.close();const call=(action:string,payload:unknown)=>JSON.parse(execFileSync(process.execPath,[worker,database],{encoding:"utf8",input:JSON.stringify({actor:host,action,payload,host_version:"sha256:"+"a".repeat(64)})}));
 const source=z.object({result:z.object({checkpoint:z.record(z.string(),z.unknown())})}).parse(call("repair-recovery-checkpoint",h.pin)),{hostDispatchStallFixture}=await import("./test-helpers/repair-handoff-fixture"),native=await hostDispatchStallFixture(source.result.checkpoint),reply=z.object({result:z.object({held:z.object({sourceKind:z.literal("prepared-dispatch"),kernelVersion:z.string(),hostVersion:z.string(),dispatchStall:z.object({claimed_at:z.null(),task_id:z.string()})})})}).parse(call("repair-dispatch-hold",{...h.pin,native}));expect(reply.result.held.kernelVersion).toMatch(/^sha256:[a-f0-9]{64}$/);expect(reply.result.held.hostVersion).toBe("sha256:"+"a".repeat(64));expect(reply.result.held.dispatchStall.task_id).toBe(h.ready.continuation.task_id);app=new EngineeringApplication(database,definition);
});

for(const kind of ["direct","verification"] as const)it(`keeps ${kind} recovery held when repository validation or physical binding fails`,async()=>{
 const h=await recoveredProgress(kind,false),db=new DatabaseSync(database),table=kind==="direct"?"direct_contract":"engineering_contract",before=String(db.prepare(`SELECT payload FROM ${table}`).get()!.payload);
 await expect(invoke(h.daemon,"bind",{work_dir:join(repository,"missing"),mode:"in_place",overlays:[]})).rejects.toThrow();expect(db.prepare("SELECT state,attempt_id FROM engineering_repair_dispatch WHERE target_hash=?").get(h.ready.target_hash)).toMatchObject({state:"ready",attempt_id:null});
 db.exec("CREATE TRIGGER fail_atomic_binding BEFORE INSERT ON engineering_process_binding BEGIN SELECT RAISE(ABORT,'fixture physical binding failed'); END");await expect(invoke(h.daemon,"bind",{work_dir:repository,mode:"in_place",overlays:[]})).rejects.toThrow(/physical binding failed/);expect(db.prepare(`SELECT payload FROM ${table}`).get()!.payload).toBe(before);expect(db.prepare("SELECT state,attempt_id FROM engineering_repair_dispatch WHERE target_hash=?").get(h.ready.target_hash)).toMatchObject({state:"ready",attempt_id:null});
 expect(db.prepare("SELECT count(*) AS n FROM engineering_process_binding WHERE attempt_id=?").get(h.successor.attemptId)!.n).toBe(0);if(kind==="verification")expect(db.prepare("SELECT count(*) AS n FROM engineering_execution WHERE attempt_id=?").get(h.successor.attemptId)!.n).toBe(0);expect(await invoke(host,"repair-recovery-checkpoint",h.pin)).toMatchObject({reason:"prepared",checkpoint:{attempt_id:null}});db.exec("DROP TRIGGER fail_atomic_binding");await invoke(h.daemon,"bind",{work_dir:repository,mode:"in_place",overlays:[]});expect(await invoke(host,"repair-recovery-checkpoint",h.pin)).toMatchObject({reason:"editable",checkpoint:{attempt_id:h.successor.attemptId}});db.close();
});

for(const kind of ["direct","verification"] as const)it(`retains an actual bound ${kind} source while holding its never-claimed continuation`,async()=>{
 const h=await recoveredProgress(kind),db=new DatabaseSync(database),{hostBoundDispatchStallFixture,hostHandoffTargetFixture}=await import("./test-helpers/repair-handoff-fixture");
 const source=z.object({checkpoint:z.record(z.string(),z.unknown())}).parse(await invoke(host,"repair-recovery-checkpoint",h.pin)),native=await hostBoundDispatchStallFixture(source.checkpoint);
 const held=z.object({held:z.object({observationId:z.string(),snapshotHash:z.string(),attemptId:z.string(),sourceKind:z.literal("bound-dispatch")}).passthrough()}).parse(await invoke(host,"repair-dispatch-hold",{...h.pin,native})).held;
 expect(held.attemptId).toBe(h.successor.attemptId);expect(await invoke(host,"execution-permission")).toEqual({allowed:false});
 expect(db.prepare("SELECT count(*) AS n FROM engineering_process_binding WHERE attempt_id LIKE ?").get(native.task_id+":%")!.n).toBe(0);
 app.close();app=new EngineeringApplication(database,definition);expect(await invoke(host,"repair-dispatch-hold",{...h.pin,native})).toEqual({held});
 const ack={case_id:native.case_id,observation_id:held.observationId,snapshot_hash:held.snapshotHash};await invoke(host,"repair-observation-ack",ack);
 expect(await invoke(host,"repair-source",ack)).toMatchObject({attempt_id:h.successor.attemptId,dispatch_task_id:native.task_id,dispatch_hold_hash:native.hash});
 const target=await hostHandoffTargetFixture(held,{...human,projectId,repositoryPath:repository,caseId:native.case_id});target.verificationAttemptId=`verified-bound-stall-${randomUUID()}`;target.workspaceBinding.runtimeId=native.runtime_id;
 const reservation=hostHandoffReservationFixture(target,await invoke(host,"repair-handoff-prepare",target)),application=await invoke(host,"repair-handoff-stage",reservation),ready=handoffReadySchema.parse(await invoke(host,"repair-handoff-ready",application)),next={...owner,attemptId:`${ready.continuation.task_id}:7777777`};await invoke({...next,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});
 await expect(invoke(h.successor,kind === "direct" ? "direct-run" : "start")).rejects.toThrow(/surrendered|end execution/);
 if(kind==="direct"){await invoke(next,"direct-run");await invoke(next,"direct-submit",{summary:"Ordinary result after bound continuation recovery"});}else await finishRecoveredVerification(next);
 expect(await invoke(host,"repair-business-progress",{target_hash:ready.target_hash,application_hash:ready.application_hash,ready_hash:ready.hash})).toMatchObject({progress:{applied:true,attempt_id:next.attemptId}});db.close();
},15000);

it("holds an answered YAML continuation and retains the authenticated human fact",async()=>{
 const h=await recoveredProgress("verification");let state=z.object({draft:draftSchema}).parse(await invoke(h.successor,"start"));
 const command=async(command:unknown)=>{state=z.object({draft:draftSchema}).parse(await invoke(h.successor,"command",{expected_sequence:state.draft.sequence,command}));};
 await command({type:"phase.complete"});await command({type:"runtime-input.put",key:"entry",title:"Entry",question:"Which entry?",why:"Need isolated data",recommendation:"Use local entry"});await command({type:"phase.complete"});
 expect(await invoke(host,"repair-recovery-checkpoint",h.pin)).toEqual({checkpoint:null,reason:"waiting-for-answers"});
 await invoke(human,"answer",{expected_sequence:state.draft.sequence,request_id:state.draft.runtimeInputs[0]!.id,answer:"Use the isolated local entry"});
 const source=z.object({checkpoint:z.record(z.string(),z.unknown())}).parse(await invoke(host,"repair-recovery-checkpoint",h.pin)),{hostBoundDispatchStallFixture,hostHandoffTargetFixture}=await import("./test-helpers/repair-handoff-fixture"),native=await hostBoundDispatchStallFixture(source.checkpoint);
 await expect(invoke(host,"repair-recovery-hold",{...h.pin,native:recoveryFault(source.checkpoint)})).rejects.toThrow(/Answered continuation/);
 const held=z.object({held:z.object({observationId:z.string(),snapshotHash:z.string()}).passthrough()}).parse(await invoke(host,"repair-dispatch-hold",{...h.pin,native})).held;
 await invoke(host,"repair-observation-ack",{case_id:native.case_id,observation_id:held.observationId,snapshot_hash:held.snapshotHash});
 const target=await hostHandoffTargetFixture(held,{...human,projectId,repositoryPath:repository,caseId:native.case_id});target.verificationAttemptId=`verified-answer-stall-${randomUUID()}`;target.workspaceBinding.runtimeId=native.runtime_id;
 const reservation=hostHandoffReservationFixture(target,await invoke(host,"repair-handoff-prepare",target)),application=await invoke(host,"repair-handoff-stage",reservation),ready=handoffReadySchema.parse(await invoke(host,"repair-handoff-ready",application)),next={...owner,attemptId:`${ready.continuation.task_id}:8888888`};await invoke({...next,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});
 const current=z.object({draft:draftSchema}).parse(await invoke(next,"start"));expect(current.draft.runtimeInputs.some(input=>input.answer?.userId===human.userId&&input.answer.text==="Use the isolated local entry")).toBe(true);
},15000);

it("round-trips a bound continuation hold through the private worker without a queued execution binding",async()=>{
 const h=await recoveredProgress("direct"),worker=new URL("./dist/worker.mjs",import.meta.url).pathname,{hostBoundDispatchStallFixture}=await import("./test-helpers/repair-handoff-fixture");app.close();
 try{
  const call=(action:ApplicationRequest["action"],payload:unknown)=>JSON.parse(execFileSync(process.execPath,[worker,database],{encoding:"utf8",stdio:["pipe","pipe","ignore"],input:JSON.stringify({actor:host,action,payload,host_version:"sha256:"+"a".repeat(64)})}));
  const source=z.object({result:z.object({checkpoint:z.record(z.string(),z.unknown())})}).parse(call("repair-recovery-checkpoint",h.pin)),native=await hostBoundDispatchStallFixture(source.result.checkpoint),reply=z.object({result:z.object({held:z.object({sourceKind:z.literal("bound-dispatch"),attemptId:z.string(),kernelVersion:z.string(),dispatchStall:z.object({task_id:z.string()})})})}).parse(call("repair-dispatch-hold",{...h.pin,native}));
  expect(reply.result.held.attemptId).toBe(h.successor.attemptId);expect(reply.result.held.kernelVersion).toBe(`sha256:${createHash("sha256").update(await readFile(worker)).digest("hex")}`);
  const db=new DatabaseSync(database);expect(db.prepare("SELECT count(*) AS n FROM engineering_process_binding WHERE attempt_id LIKE ?").get(native.task_id+":%")!.n).toBe(0);expect(db.prepare("SELECT count(*) AS n FROM engineering_intervention_view WHERE attempt_id=?").get(h.successor.attemptId)!.n).toBe(0);db.close();
 }finally{app=new EngineeringApplication(database,definition);}
 expect(await invoke(host,"execution-permission")).toEqual({allowed:false});
},15000);
