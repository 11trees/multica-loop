import {createHash} from "node:crypto";
import {lstatSync,readdirSync,readFileSync,realpathSync} from "node:fs";
import {basename,isAbsolute,join,relative} from "node:path";
import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";
import {DraftConflictError} from "./runtime";

const text=z.string().min(1),digest=z.string().regex(/^[a-f0-9]{64}$/);
const resource=z.strictObject({ref:text,path:text,title:text,sha256:digest,content:z.string(),kind:z.literal("document"),storage:z.literal("repository"),format:z.literal("markdown"),authority:z.literal("source_material")});
const snapshot=z.strictObject({format:z.literal("engineering-repository-context-v1"),adapter:z.literal("openspec"),workspaceId:z.uuid(),issueId:z.uuid(),attemptId:text,agentId:z.uuid(),chain:text,teamBindingId:z.uuid(),teamRevision:z.number().int().positive(),repositoryPath:text,contractRevision:z.number().int().positive(),codeVersion:text,capturedAt:z.iso.datetime(),resources:z.array(resource),hash:digest});
export type RepositoryContext=z.infer<typeof snapshot>;
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const missing=(path:string)=>{try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}};

/** Read source material only; these documents cannot replace frozen acceptances. */
export function readOpenSpecContext(root:string){
 if(!isAbsolute(root)||realpathSync(root)!==root)throw new Error("Repository context requires the authorized canonical root");
 for(const path of [join(root,"openspec"),join(root,"openspec/changes")]){const stat=missing(path);if(!stat)return [];if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("OpenSpec context must use regular repository directories");}
 const changes=join(root,"openspec/changes"),files:string[]=[];
 const visit=(directory:string)=>{for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,"en"))){const path=join(directory,entry.name);if(entry.isSymbolicLink())throw new Error("OpenSpec context cannot follow repository links");if(entry.isDirectory())visit(path);else if(entry.isFile()&&entry.name.toLowerCase().endsWith(".md"))files.push(path);else if(!entry.isFile())throw new Error("OpenSpec context contains an unsupported object");if(files.length>256)throw new Error("OpenSpec context exceeds 256 Markdown documents");}};
 for(const entry of readdirSync(changes,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,"en"))){if(entry.name==="archive"||entry.name.startsWith("."))continue;if(entry.isSymbolicLink())throw new Error("OpenSpec context cannot follow change links");if(entry.isDirectory())visit(join(changes,entry.name));}
 let bytes=0;return files.map(path=>{const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||realpathSync(path)!==path)throw new Error("OpenSpec context file changed");const data=readFileSync(path),after=lstatSync(path),content=data.toString("utf8");bytes+=data.length;if(bytes>512*1024||data.length>256*1024)throw new Error("OpenSpec context exceeds bounded material capacity");if(!Buffer.from(content).equals(data)||["dev","ino","size","mtimeMs","ctimeMs"].some(key=>before[key as keyof typeof before]!==after[key as keyof typeof after]))throw new Error("OpenSpec context content changed or is not UTF-8");const relativePath=relative(root,path).split("\\").join("/");return resource.parse({ref:`REPO:OPENSPEC:${relativePath}`,path:relativePath,title:basename(path),sha256:createHash("sha256").update(data).digest("hex"),content,kind:"document",storage:"repository",format:"markdown",authority:"source_material"});});
}

export class RepositoryContextStore{
 constructor(private readonly db:DatabaseSync){db.exec("CREATE TABLE IF NOT EXISTS engineering_repository_context(workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,attempt_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id,attempt_id))");}
 read(input:Omit<RepositoryContext,"format"|"adapter"|"capturedAt"|"resources"|"hash">){
  const prior=this.db.prepare("SELECT payload FROM engineering_repository_context WHERE workspace_id=? AND issue_id=? AND attempt_id=?").get(input.workspaceId,input.issueId,input.attemptId);
  if(prior){const saved=snapshot.parse(JSON.parse(String(prior.payload))),{hash:expected,...body}=saved;if(hash(body)!==expected||Object.entries(input).some(([key,value])=>body[key as keyof typeof body]!==value))throw new DraftConflictError("Frozen repository context belongs to another execution or Team");return saved;}
  const resources=readOpenSpecContext(input.repositoryPath);if(hash(readOpenSpecContext(input.repositoryPath))!==hash(resources))throw new DraftConflictError("OpenSpec context changed while freezing the document cohort");
  const body={format:"engineering-repository-context-v1" as const,adapter:"openspec" as const,...input,capturedAt:new Date().toISOString(),resources},saved=snapshot.parse({...body,hash:hash(body)});
  this.db.prepare("INSERT INTO engineering_repository_context VALUES(?,?,?,?)").run(input.workspaceId,input.issueId,input.attemptId,JSON.stringify(saved));return saved;
 }
}
export const repositoryContextInstructions="Read the frozen OpenSpec repository resources and their exact path/hash below. They are source material for investigation, not independent verification or replacement acceptance criteria. Resolve conflicts through the normal decisions and human-input gates. The same native attempt retains this document version; a later attempt captures a new version.";
