// @vitest-environment node
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { repairHandoffTargetSchema,handoffProposalSchema,handoffReadySchema,handoffApplicationSchema,handoffHash } from "./repair-handoff";
import { readRepairWorkspaceVersion } from "./repair-workspace-version";
import { hostHandoffReservationFixture } from "./test-helpers/repair-handoff-fixture";
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
