// @vitest-environment node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
it("runs management RPC without initializing business tables and refuses mode reversal",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"admin-worker-")),database=join(directory,"admin.sqlite"),worker=new URL("./dist/worker.mjs",import.meta.url).pathname;
 const invoke=(input:unknown,admin=true)=>JSON.parse(execFileSync(process.execPath,[worker,database,...(admin?["--admin"]:[])],{encoding:"utf8",input:JSON.stringify(input)}));
 try{expect(invoke({action:"acquire",owner_id:"host"}).result.authority).toMatchObject({ownerId:"host",token:1});expect(invoke({action:"issue",workspace_id:randomUUID(),issue_id:randomUUID()}).result).toEqual({recorded:false});
  expect(invoke({action:"overview",actor:{kind:"human",workspaceId:randomUUID(),issueId:randomUUID(),userId:randomUUID()}},false).error).toMatch(/cannot reuse/);
  const db=new DatabaseSync(database);expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name)).toEqual(["admin_case","admin_control","admin_observation"]);db.close();
 }finally{await rm(directory,{recursive:true,force:true});}
});
