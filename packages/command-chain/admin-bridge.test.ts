import { z } from "zod";
// @vitest-environment node
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AdminStore } from "./admin-store";
import { EngineeringApplication } from "./application";

it("ingests before acknowledgement, replays the same observation after interruption and leaves business blocked",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"admin-bridge-")),repository=join(directory,"repository");execFileSync("git",["init","-q",repository]);const git=(...args:string[])=>execFileSync("git",["-C",repository,...args],{stdio:"ignore"});git("config","user.name","Fixture");git("config","user.email","fixture@example.invalid");await writeFile(join(repository,"README.md"),"Original\n");git("add",".");git("commit","-qm","Original");
 const source=await readFile(new URL("./definitions/verification.yaml",import.meta.url),"utf8"),database=join(directory,"business.sqlite"),human={kind:"human" as const,workspaceId:randomUUID(),issueId:randomUUID(),userId:randomUUID()},agentId=randomUUID(),projectId=randomUUID();let app=new EngineeringApplication(database,source,undefined,undefined,undefined,undefined,"sha256:"+"a".repeat(64));const admin=new AdminStore(join(directory,"admin.sqlite"));
 const actor={kind:"task" as const,workspaceId:human.workspaceId,issueId:human.issueId,agentId,projectId,attemptId:`${randomUUID()}:1`};
 try{
  await app.invoke({actor:human,action:"configure-direct",payload:{expected_revision:0,agent_id:agentId,project_id:projectId,repository_path:repository,input:"Preserve meaning",execution_resources:[{path:repository,mode:"in_place"}]}});await app.invoke({actor:{...actor,kind:"daemon"},action:"bind",payload:{work_dir:repository,mode:"in_place",overlays:[]}});await app.invoke({actor,action:"direct-run"});await app.invoke({actor,action:"intervention-request",host_version:"sha256:"+"b".repeat(64),payload:{summary:"Conflict",reason:"Original oracle disagrees",evidence:"Original investigation"}});
  const rows=z.array(z.object({observationId:z.string(),workspaceId:z.string(),issueId:z.string(),chain:z.string(),requestHash:z.string(),snapshotHash:z.string(),kernelVersion:z.string(),summary:z.string()}).passthrough()).parse(await app.invoke({actor:{kind:"coordinator"},action:"repair-observations"}));const row=rows[0]!;
  const authority=admin.acquireSupervisor("host")!,observation={observationId:row.observationId,workspaceId:row.workspaceId,issueId:row.issueId,scope:"work-item",scopeKey:`${row.workspaceId}:${row.issueId}:${row.chain}`,fingerprint:row.requestHash,sourceVersion:row.kernelVersion!,summary:row.summary,evidence:{original:row},origin:"business"},first=admin.observe(authority,observation);
  app.close();app=new EngineeringApplication(database,source);expect(admin.observe(authority,observation).caseId).toBe(first.caseId);
  const host={kind:"host" as const,workspaceId:human.workspaceId,issueId:human.issueId},payload={observation_id:row.observationId,case_id:first.caseId,snapshot_hash:row.snapshotHash};expect(await app.invoke({actor:host,action:"repair-observation-ack",payload})).toEqual({acknowledged:true});expect(await app.invoke({actor:host,action:"repair-observation-ack",payload})).toEqual({acknowledged:true});
  expect(await app.invoke({actor:{kind:"coordinator"},action:"repair-observations"})).toEqual([]);expect(admin.issue(human.workspaceId,human.issueId)).toMatchObject({observation_count:1});await expect(app.invoke({actor:host,action:"completion"})).rejects.toThrow(/surrendered/);await expect(app.invoke({actor,action:"repair-observation-ack",payload})).rejects.toThrow(/Only the host/);await expect(app.invoke({actor:host,action:"repair-observation-ack",payload:{...payload,case_id:"another-case"}})).rejects.toThrow(/another Admin Case/);
 }finally{app.close();admin.close();await rm(directory,{recursive:true,force:true});}
});
