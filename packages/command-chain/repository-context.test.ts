// @vitest-environment node
import {randomUUID,createHash} from "node:crypto";
import {mkdir,mkdtemp,realpath,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {afterEach,beforeEach,expect,it} from "vitest";
import {RepositoryContextStore,readOpenSpecContext} from "./repository-context";
let root:string,db:DatabaseSync;
beforeEach(async()=>{root=await realpath(await mkdtemp(join(tmpdir(),"repository-context-")));db=new DatabaseSync(":memory:");await mkdir(join(root,"openspec/changes/current/specs/context"),{recursive:true});await writeFile(join(root,"openspec/changes/current/proposal.md"),"# Original proposal\n");await writeFile(join(root,"openspec/changes/current/specs/context/spec.md"),"# Existing behavior\n");});
afterEach(async()=>{db.close();await rm(root,{recursive:true,force:true});});
const input=(root:string)=>({workspaceId:randomUUID(),issueId:randomUUID(),attemptId:"native:claim:1",agentId:randomUUID(),chain:"context",teamBindingId:randomUUID(),teamRevision:1,repositoryPath:root,contractRevision:1,codeVersion:"a".repeat(40)});
it("reads the original OpenSpec active-change scope with exact path/hash/text and no inferred verification authority",async()=>{
 for(const name of ["archive",".hidden"]){await mkdir(join(root,"openspec/changes",name));await writeFile(join(root,"openspec/changes",name,"excluded.md"),"Never include archived or hidden changes");}await writeFile(join(root,"openspec/changes/root.md"),"Not a change directory");
 const docs=readOpenSpecContext(root);expect(docs.map(row=>row.path)).toEqual(["openspec/changes/current/proposal.md","openspec/changes/current/specs/context/spec.md"]);expect(docs[0]).toMatchObject({ref:"REPO:OPENSPEC:openspec/changes/current/proposal.md",content:"# Original proposal\n",authority:"source_material",sha256:createHash("sha256").update("# Original proposal\n").digest("hex")});
});
it("freezes an attempt across source changes and storage reopen, and rejects cross-role or cross-root reuse",async()=>{
 const store=new RepositoryContextStore(db),scope=input(root),first=store.read(scope);await writeFile(join(root,"openspec/changes/current/proposal.md"),"# Later proposal\n");expect(new RepositoryContextStore(db).read(scope)).toEqual(first);
 for(const change of [{agentId:randomUUID()},{chain:"review"},{teamBindingId:randomUUID()},{repositoryPath:join(root,"other")},{teamRevision:2},{contractRevision:2},{codeVersion:"b".repeat(40)}])expect(()=>store.read({...scope,...change})).toThrow(/another execution or Team/);
 const later=store.read({...scope,attemptId:"native:claim:2"});expect(later.hash).not.toBe(first.hash);expect(later.resources[0]!.content).toContain("Later proposal");
 const edited={...first,resources:[]};db.prepare("UPDATE engineering_repository_context SET payload=? WHERE attempt_id=?").run(JSON.stringify(edited),scope.attemptId);expect(()=>store.read(scope)).toThrow(/Frozen repository context/);
});
it("refuses linked or oversized material before storing an attempt and permits an absent OpenSpec directory",async()=>{
 const store=new RepositoryContextStore(db),scope=input(root);await symlink(join(root,"openspec/changes/current/proposal.md"),join(root,"openspec/changes/current/linked.md"));expect(()=>store.read(scope)).toThrow(/links/);expect(db.prepare("SELECT count(*) n FROM engineering_repository_context").get()!.n).toBe(0);await rm(join(root,"openspec/changes/current/linked.md"));await writeFile(join(root,"openspec/changes/current/proposal.md"),"x".repeat(256*1024+1));expect(()=>store.read(scope)).toThrow(/capacity/);expect(db.prepare("SELECT count(*) n FROM engineering_repository_context").get()!.n).toBe(0);await rm(join(root,"openspec"),{recursive:true});expect(store.read(scope).resources).toEqual([]);
});
