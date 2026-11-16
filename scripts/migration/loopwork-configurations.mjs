import {createHash,randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {lstat,mkdir,readFile,readdir,realpath,rename,rm,writeFile} from "node:fs/promises";
import {basename,dirname,isAbsolute,join,relative,resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {copyDatabase,sourceFiles,verifyArchive} from "./loopwork-history-lib.mjs";

const format="loopwork-configuration-retention-v1";
const sha=value=>createHash("sha256").update(value).digest("hex");
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
const hash=value=>sha(JSON.stringify(canonical(value)));
const columns={
 agent_configuration_sets:"configuration_id agent_id name is_active created_at updated_at prompt_content prompt_hash prompt_revision prompt_source prompt_reason prompt_template_version builtin_key context_adapter".split(" "),
 agent_configuration_documents:"configuration_id command_chain_id yaml_content content_hash revision updated_at system_managed".split(" "),
 agent_configuration_prompt_candidates:"candidate_id configuration_id agent_id revision base_prompt_revision content content_hash reason evidence_json remaining_runs created_at updated_at".split(" "),
 agent_configuration_canary_receipts:"candidate_id execution_id outcome updated_at".split(" "),
};
const chains=[
 ["idea-context","idea-context-agent","intent","idea-context-agent.yaml"],
 ["business-design","business-design-agent","business_design","business-design-agent.yaml"],
 ["requirement-spec","requirement-spec-agent","specification","requirement-spec-agent.yaml"],
 ["spec-review","spec-review-agent","review","spec-review-agent.yaml"],
 ["requirement-context","backlog-agent","context","backlog-agent.yaml"],
 ["delivery-plan","story-splitter-agent","planner","story-splitter-agent.yaml"],
 ["delivery-analysis","analyst-agent","analyst","analyst-agent.yaml"],
 ["reproduction","repro-agent","reproducer","repro-agent.yaml"],
 ["development","dev-agent","developer","dev-agent.yaml"],
 ["verification","test-agent","verifier","test-agent.yaml"],
 ["review","review-agent","reviewer","review-agent.yaml"],
 ["feedback-triage","feedback-agent","feedback.triager","feedback-agent.triage.yaml"],
 ["feedback-verify","feedback-agent","feedback.verifier","feedback-agent.verify.yaml"],
];
const delivery=["context","planner","analyst","developer","verifier","reviewer"];
const workflows={direct:["executor"],business_analysis:["intent","business_design","specification","review"],end_to_end:["intent","business_design","specification","review",...delivery],develop:delivery,bug_fix:["reproducer",...delivery]};
const agentForRole=role=>role==="executor"?"direct-agent":chains.find(item=>item[2]===role)?.[1];
const within=(parent,child)=>{const part=relative(parent,child);return !part||part!==".."&&!part.startsWith("../")&&!isAbsolute(part);};
const regular=async path=>{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error("Configuration retention requires regular files");return stat;};
async function futurePath(path){const suffix=[];let current=path;while(!await lstat(current).catch(error=>{if(error.code==="ENOENT")return null;throw error;})){suffix.unshift(basename(current));current=dirname(current);}return join(await realpath(current),...suffix);}
const git=(root,...args)=>execFileSync("git",["--no-optional-locks","-c","core.fsmonitor=false","-C",root,...args],{env:{...process.env,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",GIT_NO_LAZY_FETCH:"1",GIT_ALLOW_PROTOCOL:""},encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();

function selectConfiguration(path){
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  db.exec("PRAGMA query_only=ON;PRAGMA trusted_schema=OFF");const result={};
  for(const [table,fields] of Object.entries(columns)){
   const definition=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
   const actual=db.prepare(`PRAGMA table_info("${table}")`).all().map(row=>row.name);
   if(!definition||/^CREATE\s+VIRTUAL/i.test(definition.sql)||JSON.stringify(actual.toSorted())!==JSON.stringify(fields.toSorted()))throw new Error(`Unsupported configuration schema: ${table}`);
   result[table]=db.prepare(`SELECT ${fields.map(name=>`"${name}"`).join(",")} FROM "${table}" ORDER BY ${fields.slice(0,table.endsWith("documents")||table.endsWith("receipts")?2:1).map(name=>`"${name}"`).join(",")}`).all().map(row=>({...row}));
  }
  return result;
 }finally{db.close();}
}

function validateSelection(data){
 if(Object.keys(data).sort().join()!==Object.keys(columns).sort().join())throw new Error("Configuration payload contains unapproved tables");
 for(const [table,fields] of Object.entries(columns))for(const row of data[table])if(Object.keys(row).sort().join()!==fields.toSorted().join())throw new Error("Configuration payload contains unapproved fields");
 const sets=data.agent_configuration_sets,ids=new Set(),active=new Set();
 for(const set of sets){
  if(ids.has(set.configuration_id)||![0,1].includes(set.is_active)||![null,"default","openspec"].includes(set.builtin_key)||![null,"openspec"].includes(set.context_adapter)||!["system","human","evolution"].includes(set.prompt_source)||sha(set.prompt_content)!==set.prompt_hash)throw new Error("Configuration identity or prompt hash is invalid");
  ids.add(set.configuration_id);if(set.is_active){if(active.has(set.agent_id))throw new Error("Multiple active configurations for one legacy Agent");active.add(set.agent_id);}
 }
 for(const doc of data.agent_configuration_documents)if(!ids.has(doc.configuration_id)||sha(doc.yaml_content)!==doc.content_hash||![0,1].includes(doc.system_managed))throw new Error("Configuration document ownership or hash is invalid");
 for(const candidate of data.agent_configuration_prompt_candidates)if(!sets.some(set=>set.configuration_id===candidate.configuration_id&&set.agent_id===candidate.agent_id)||sha(candidate.content)!==candidate.content_hash)throw new Error("Configuration candidate ownership or hash is invalid");
 for(const receipt of data.agent_configuration_canary_receipts)if(!data.agent_configuration_prompt_candidates.some(candidate=>candidate.candidate_id===receipt.candidate_id))throw new Error("Configuration canary has no retained candidate");
}

export function configurationPlan(data,bundles){
 validateSelection(data);const active=data.agent_configuration_sets.filter(set=>set.is_active),find=agent=>active.find(set=>set.agent_id===agent);
 const documents=data.agent_configuration_documents.map(doc=>{
  const set=data.agent_configuration_sets.find(set=>set.configuration_id===doc.configuration_id),entry=chains.find(item=>item[0]===doc.command_chain_id),bundle=entry&&bundles[`${set.builtin_key==="openspec"?"openspec":"default"}/${entry[3]}`];
  const mapping=entry&&entry[1]===set.agent_id?entry[2]:null;
  return {configuration_id:set.configuration_id,command_chain_id:doc.command_chain_id,active:!!set.is_active,role:mapping,stored_hash:doc.content_hash,effective_hash:doc.system_managed?bundle?.sha256??null:doc.content_hash,disposition:!mapping||doc.system_managed&&!bundle?"requires_reconciliation":doc.system_managed?"pinned_system_bundle":bundle?.sha256===doc.content_hash?"stored_matches_bundle":"custom_yaml_requires_port"};
 });
 const teams=Object.entries(workflows).map(([workflow,roles])=>{
  const contextRoles=delivery.filter(role=>roles.includes(role)),adapters=contextRoles.map(role=>find(agentForRole(role))?.context_adapter??null),count=adapters.filter(value=>value==="openspec").length;
  return {workflow,roles:roles.map(role=>{const set=find(agentForRole(role));return {role,legacy_agent_id:agentForRole(role),configuration_id:set?.configuration_id??null,prompt_source:set?.prompt_source??null,prompt_hash:set?.prompt_hash??null,disposition:!set?"source_default_fallback_requires_review":set.prompt_source==="system"?"system_prompt_requires_target_comparison":"custom_prompt_requires_port"};}),repository_context:!contextRoles.length?"not_applicable":count===contextRoles.length?"openspec":count?"mixed_role_context_requires_decision":"default"};
 });
 return {teams,documents,unmapped_active_agents:active.filter(set=>!Object.values(workflows).flat().some(role=>agentForRole(role)===set.agent_id)&&set.agent_id!=="feedback-agent").map(set=>set.agent_id),feedback:{active_configuration_id:find("feedback-agent")?.configuration_id??null,disposition:"separate_native_triage_and_verification_agents_required"},pending_prompt_candidates:data.agent_configuration_prompt_candidates.map(row=>row.candidate_id),installation_authorized:false,native_tasks_changed:0};
}

export async function captureConfigurations({archive,expectedHash,output,afterCopy}){
 if(!isAbsolute(archive)||!isAbsolute(output)||!/^[a-f0-9]{64}$/.test(expectedHash))throw new Error("Use absolute paths and the pinned history hash");
 output=resolve(output);
 const primary=await verifyArchive(archive);if(primary.hash!==expectedHash)throw new Error("History archive identity differs");
 const root=await realpath(primary.source.repository),dataRoot=await realpath(primary.source.data_root);
 if(git(root,"rev-parse","HEAD")!==primary.source.commit||git(root,"status","--porcelain","--untracked-files=no"))throw new Error("Configuration capture requires the unchanged pinned source checkout");
 if(!primary.application_inventory.some(item=>item.source_name==="loopwork.db"))throw new Error("Pinned source application inventory is unavailable");
 output=await futurePath(output);
 for(const source of [root,dataRoot,await realpath(archive)])if(within(source,output)||within(output,source))throw new Error("Configuration output must be disjoint from source and history");
 if(await lstat(output).catch(error=>{if(error.code==="ENOENT")return null;throw error;}))throw new Error("Never overwrite configuration retention");
 await mkdir(dirname(output),{recursive:true,mode:0o700});
 const stage=join(dirname(output),`.configurations-${randomUUID()}`);await mkdir(stage,{mode:0o700});
 try{
  const copied=await copyDatabase(join(dataRoot,"loopwork.db"),join(stage,"source.sqlite"),afterCopy),selection=selectConfiguration(join(stage,"source.sqlite"));validateSelection(selection);
  const bundles={};for(const [, , ,name] of chains)for(const pack of ["default","openspec"]){const path=join(root,"command-chains",pack,name);const stat=await lstat(path).catch(error=>{if(error.code==="ENOENT")return null;throw error;});if(!stat)continue;await regular(path);if(await realpath(path)!==path)throw new Error("Bundled configuration cannot follow links");const content=(await readFile(path,"utf8")).trimEnd()+"\n";bundles[`${pack}/${name}`]={sha256:sha(content),content};}
  const body={format,history_hash:expectedHash,source:{repository:root,data_root:dataRoot,commit:primary.source.commit,application_files:copied.source_files},captured_at:new Date().toISOString(),selection,bundles,plan:configurationPlan(selection,bundles),exclusions:["Runtime, provider, account, credential, application-settings and all other table payloads are excluded.","Prompts, YAML and candidate evidence can contain private project text; retain this artifact privately.","This later source snapshot does not replace the original history archive or install configuration, activate tasks, launch a provider or grant verification authority."]};
  await rm(join(stage,"source.sqlite"));const manifest={...body,hash:hash(body)};await writeFile(join(stage,"manifest.json"),JSON.stringify(manifest,null,2)+"\n",{mode:0o600,flag:"wx"});
  if(hash(await sourceFiles(join(dataRoot,"loopwork.db")))!==hash(copied.source_files)||git(root,"rev-parse","HEAD")!==primary.source.commit||git(root,"status","--porcelain","--untracked-files=no"))throw new Error("Configuration source changed before publication");
  await verifyConfigurations(stage,manifest.hash);await rename(stage,output);return {archive:output,hash:manifest.hash,configurations:selection.agent_configuration_sets.length,active_configurations:selection.agent_configuration_sets.filter(row=>row.is_active).length,documents:selection.agent_configuration_documents.length,plan:manifest.plan};
 }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
}

export async function verifyConfigurations(archive,expectedHash){
 if(!isAbsolute(archive)||!/^[a-f0-9]{64}$/.test(expectedHash))throw new Error("Use absolute retention path and expected hash");
 archive=await realpath(archive);if((await readdir(archive)).join()!=="manifest.json")throw new Error("Configuration retention contains an unexpected payload");await regular(join(archive,"manifest.json"));const manifest=JSON.parse(await readFile(join(archive,"manifest.json"),"utf8")),{hash:actual,...body}=manifest;
 if(manifest.format!==format||actual!==expectedHash||actual!==hash(body))throw new Error("Configuration retention identity differs");
 validateSelection(manifest.selection);for(const bundle of Object.values(manifest.bundles))if(sha(bundle.content)!==bundle.sha256)throw new Error("Retained bundle hash differs");
 if(hash(configurationPlan(manifest.selection,manifest.bundles))!==hash(manifest.plan))throw new Error("Configuration Team correspondence differs");
 return manifest;
}

export async function main(args){
 const [action,...rest]=args,options={};for(let index=0;index<rest.length;index+=2){if(!rest[index]?.startsWith("--")||!rest[index+1]||Object.hasOwn(options,rest[index]))throw new Error("Use distinct configuration options");options[rest[index]]=rest[index+1];}
 const allowed=action==="capture"?["--archive","--expected-hash","--output"]:action==="verify"?["--archive","--expected-hash"]:[];
 if(!allowed.length||Object.keys(options).sort().join()!==allowed.sort().join())throw new Error("Use capture --archive /history --expected-hash sha256 --output /new-retention | verify --archive /retention --expected-hash sha256");
 if(action==="capture")return captureConfigurations({archive:options["--archive"],expectedHash:options["--expected-hash"],output:options["--output"]});
 const manifest=await verifyConfigurations(options["--archive"],options["--expected-hash"]);return {hash:manifest.hash,verified:true,plan:manifest.plan};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
