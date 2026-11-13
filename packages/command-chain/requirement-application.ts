import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ApplicationRequest } from "./application";
import { CommandChainEngine, DraftConflictError, chainCommandSchema, type ChainDraft } from "./runtime";
import { SqliteDraftStore } from "./sqlite-store";
import { parseCommandChainDefinition } from "./definition";
import { compileContextConclusion, contextContractSchema, contextProfile, createContextHandlers } from "./context";
import { compilePlanningConclusion, planningContractSchema, planningProfile, createPlanningHandlers } from "./planning";
import { decisionModeSchema, decisionPolicies, decisionProposalSchema } from "./decisions";
import { captureRepositoryOverlays, repositoryCommonDirectory, repositorySnapshot } from "./repository";
import { artifactBlock } from "./artifacts";

const text=z.string().trim().min(1),sequence=z.number().int().nonnegative();
const configuration=z.strictObject({kind:z.literal("requirement"),expected_revision:sequence,agent_id:z.uuid(),planner_agent_id:z.uuid(),repository_path:text,input:text.max(40000),item_kind:z.enum(["requirement","bug"]).default("requirement"),decision_mode:decisionModeSchema.default("balanced"),auto_continue:z.boolean().default(false)});
const acceptanceSchema=z.strictObject({id:z.uuid(),key:text,scope:z.literal("requirement"),statement:text,oracle:text,sourceRef:text,revision:z.number().int().positive(),active:z.boolean()});
const recordSchema=z.strictObject({workspaceId:z.uuid(),issueId:z.uuid(),createdBy:z.uuid(),repositoryPath:text,agentId:z.uuid(),plannerAgentId:z.uuid(),autoContinue:z.boolean(),contextDraftId:z.uuid(),planDraftId:z.uuid(),contextSource:text,planningSource:text,contextContract:contextContractSchema,contextHandoff:z.boolean(),planningContract:planningContractSchema.optional(),acceptances:z.array(acceptanceSchema).default([])});
type Record=z.infer<typeof recordSchema>;
const executionSchema=z.strictObject({repositoryPath:text,overlays:z.array(z.strictObject({path:text,hash:text,executable:z.boolean(),originalHash:text.nullable(),originalExecutable:z.boolean()}))});
export type RequirementDefinitions={context:string;planning:string};

function stableId(value:string){const hash=createHash("sha256").update(value).digest("hex");return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;}

/** Requirement-level checkpoints share the authenticated host and draft store. */
export class RequirementApplication {
  constructor(private readonly db:DatabaseSync,private readonly drafts:SqliteDraftStore,private readonly definitions?:RequirementDefinitions){
    db.exec("CREATE TABLE IF NOT EXISTS requirement_contract (workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id,revision))");
    db.exec("CREATE TABLE IF NOT EXISTS requirement_acceptance (workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,acceptance_key TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id,acceptance_key,revision))");
    db.exec("CREATE TABLE IF NOT EXISTS requirement_execution (workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,revision INTEGER NOT NULL,agent_id TEXT NOT NULL,attempt_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id,revision,agent_id,attempt_id))");
    if(definitions){parseCommandChainDefinition(definitions.context,contextProfile);parseCommandChainDefinition(definitions.planning,planningProfile);}
  }
  current(workspaceId:string,issueId:string){const row=this.db.prepare("SELECT payload FROM requirement_contract WHERE workspace_id=? AND issue_id=? ORDER BY revision DESC LIMIT 1").get(workspaceId,issueId);return row ? recordSchema.parse(JSON.parse(String(row.payload))) : undefined;}
  private save(record:Record){this.db.prepare("UPDATE requirement_contract SET payload=? WHERE workspace_id=? AND issue_id=? AND revision=?").run(JSON.stringify(record),record.workspaceId,record.issueId,record.contextContract.binding.revision);}
  private role(record:Record){return record.contextHandoff ? {chain:"planning",agentId:record.plannerAgentId,draftId:record.planDraftId,contract:record.planningContract!,source:record.planningSource,profile:planningProfile} : {chain:"context",agentId:record.agentId,draftId:record.contextDraftId,contract:record.contextContract,source:record.contextSource,profile:contextProfile};}
  private latestAcceptances(record:Record){return this.db.prepare("SELECT a.payload FROM requirement_acceptance a WHERE workspace_id=? AND issue_id=? AND revision=(SELECT MAX(v.revision) FROM requirement_acceptance v WHERE v.workspace_id=a.workspace_id AND v.issue_id=a.issue_id AND v.acceptance_key=a.acceptance_key)").all(record.workspaceId,record.issueId).map(row=>acceptanceSchema.parse(JSON.parse(String(row.payload))));}
  private async settleContext(record:Record,draft:ChainDraft){
    if(record.contextHandoff)return;
    const conclusion=compileContextConclusion(draft,record.contextContract),previous=this.latestAcceptances(record);
    const active=conclusion.acceptances.map(value=>{
      const old=previous.find(item=>item.key === value.key),same=old?.active && old.statement === value.statement && old.oracle === value.oracle && old.sourceRef === value.source;
      return acceptanceSchema.parse({id:old?.id ?? stableId(`multica:acceptance:${record.workspaceId}:${record.issueId}:${value.key}`),key:value.key,scope:"requirement",statement:value.statement,oracle:value.oracle,sourceRef:value.source,revision:same ? old.revision : (old?.revision ?? 0)+1,active:true});
    });
    const retired=previous.filter(item=>item.active && !active.some(value=>value.key === item.key)).map(item=>({...item,revision:item.revision+1,active:false}));
    const sources=[...conclusion.impacts.map(item=>({key:`impact:${item.key}`,kind:item.disposition,content:item.statement,sourceRef:`REQUIREMENT_CONTEXT:${draft.id}:impact:${item.key}`})),...active.map(item=>({key:`acceptance:${item.key}`,kind:"acceptance",content:item.statement,sourceRef:`ACCEPTANCE:${item.id}:r${item.revision}`,oracle:item.oracle}))];
    record.planningContract=planningContractSchema.parse({binding:{...record.contextContract.binding,contractVersion:createHash("sha256").update(JSON.stringify(conclusion)).digest("hex")},sources,existingKeys:[]});
    record.acceptances=active;record.contextHandoff=true;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      if(this.current(record.workspaceId,record.issueId)!.contextContract.binding.revision !== record.contextContract.binding.revision)throw new DraftConflictError("Requirement revision changed before context handoff");
      for(const item of [...active,...retired])this.db.prepare("INSERT INTO requirement_acceptance(workspace_id,issue_id,acceptance_key,revision,payload) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING").run(record.workspaceId,record.issueId,item.key,item.revision,JSON.stringify(item));
      this.save(record);this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  private async overview(record:Record){
    const role=this.role(record),draft=await this.drafts.read(role.draftId),contextDraft=record.contextHandoff ? await this.drafts.read(record.contextDraftId) : undefined;
    const context=contextDraft ? compileContextConclusion(contextDraft,record.contextContract) : null;
    const plan=role.chain === "planning" && draft?.status === "completed" ? compilePlanningConclusion(draft,record.planningContract!) : null;
    return {enabled:true,configured:true,auto_continue:record.autoContinue,chain:role.chain,agent_id:role.agentId,revision:record.contextContract.binding.revision,sequence:draft?.sequence ?? 0,code_version:role.contract.binding.codeVersion,repository_path:record.repositoryPath,draft_id:draft?.id ?? null,status:draft?.status ?? "unstarted",current_phase:draft?.phase ?? null,
      phases:Object.keys(parseCommandChainDefinition(role.source,role.profile).definition.phases).map(id=>({id,status:draft?.completedPhases.includes(id) ? "completed" : id === draft?.phase ? "current" : "pending"})),
      sources:record.planningContract?.sources.map(item=>({key:item.key,kind:item.kind,description:item.content,oracle:item.oracle ?? item.content,source_ref:item.sourceRef})) ?? [],
      artifacts:draft?.artifacts.map(item=>({...item,title:artifactBlock(draft.definition,item.ref).title})) ?? [],decisions:draft?.decisions ?? contextDraft?.decisions ?? [],
      questions:[...(contextDraft?.runtimeInputs.map(item=>({...item,active:false})) ?? []),...(draft?.runtimeInputs ?? [])].map(item=>({...item,decision_key:item.decisionKey,recommendation_option:item.recommendationOption,answer:item.answer ? {text:item.answer.text,user_id:item.answer.userId,sequence:item.answer.sequence,selected_option:item.answer.selectedOption} : null})),
      requirement:{kind:record.contextContract.kind,input:record.contextContract.input,context:context ? {intent:context.intent,changeSummary:context.changeSummary,acceptances:record.acceptances} : null,plan},result:null,
    };
  }
  async continuations(){
    const rows=this.db.prepare("SELECT r.payload FROM requirement_contract r WHERE revision=(SELECT MAX(v.revision) FROM requirement_contract v WHERE v.workspace_id=r.workspace_id AND v.issue_id=r.issue_id)").all(),pending=[];
    for(const row of rows){const record=recordSchema.parse(JSON.parse(String(row.payload)));if(!record.autoContinue)continue;
      if(!record.contextHandoff){const draft=await this.drafts.read(record.contextDraftId);if(draft?.status === "completed")await this.settleContext(record,draft);}
      const role=this.role(record),draft=await this.drafts.read(role.draftId),reason=role.chain === "planning" && !draft ? "context_handoff" : draft?.status === "waiting_for_answers" && draft.runtimeInputs.some(item=>item.active) && draft.runtimeInputs.every(item=>!item.active || item.answer) ? "human_answers" : null;
      if(reason)pending.push({workspace_id:record.workspaceId,issue_id:record.issueId,agent_id:role.agentId,user_id:record.createdBy,task_id:stableId(`multica:engineering:continuation:${role.draftId}:${draft?.sequence ?? 0}`),expected_revision:record.contextContract.binding.revision,expected_sequence:draft?.sequence ?? 0,reason});
    }return pending;
  }
  async invoke(request:ApplicationRequest){
    const {actor,action}=request;if(actor.kind === "coordinator")throw new Error("Use the requirement continuation coordinator");
    let record=this.current(actor.workspaceId,actor.issueId);
    if(action === "configure"){
      if(actor.kind !== "human")throw new Error("Only a human can freeze requirement inputs");
      const config=configuration.parse(request.payload);if(!this.definitions)throw new Error("Requirement definitions are unavailable");
      if(config.agent_id === config.planner_agent_id)throw new Error("Context and planning require separate agents");
      if(config.expected_revision !== (record?.contextContract.binding.revision ?? 0))throw new DraftConflictError("Requirement revision changed; reload before configuring");
      if(record){const draft=await this.drafts.read(this.role(record).draftId);if(draft && !["completed","abandoned"].includes(draft.status))throw new Error("Abandon the active requirement draft before replacing its input");}
      const code=repositorySnapshot(config.repository_path),revision=config.expected_revision+1;
      record=recordSchema.parse({workspaceId:actor.workspaceId,issueId:actor.issueId,createdBy:actor.userId,repositoryPath:code.repositoryPath,agentId:config.agent_id,plannerAgentId:config.planner_agent_id,autoContinue:config.auto_continue,contextDraftId:randomUUID(),planDraftId:randomUUID(),contextSource:this.definitions.context,planningSource:this.definitions.planning,contextHandoff:false,
        contextContract:{input:config.input,kind:config.item_kind,decisionMode:config.decision_mode,binding:{workspaceId:actor.workspaceId,issueId:actor.issueId,revision,codeVersion:code.codeVersion,contractVersion:createHash("sha256").update(JSON.stringify(config)).digest("hex")}}});
      const inserted=this.db.prepare("INSERT INTO requirement_contract(workspace_id,issue_id,revision,payload) VALUES(?,?,?,?) ON CONFLICT DO NOTHING").run(record.workspaceId,record.issueId,revision,JSON.stringify(record));
      if(inserted.changes !== 1)throw new DraftConflictError("Requirement revision changed");
      return this.view(record);
    }
    if(!record)throw new Error("Requirement is not configured");
    const role=this.role(record);
    if(action === "completion" || action === "verified-binding")throw new DraftConflictError("Requirement delivery and final review must complete; a context or plan is not delivered work");
    if(action === "overview"){if(actor.kind !== "human")throw new Error("A human actor is required");return this.overview(record);}
    if(action === "selection")return {configured:actor.kind === "task" && role.agentId === actor.agentId,chain:role.chain,repository_path:record.repositoryPath,code_version:role.contract.binding.codeVersion};
    if(action === "prepare-run"){
      if(actor.kind !== "human")throw new Error("Only a human can start a requirement run");
      const payload=z.object({expected_revision:sequence,expected_sequence:sequence,execution_resources:z.array(z.object({path:text,mode:z.enum(["in_place","worktree"])})).optional()}).parse(request.payload),draft=await this.drafts.read(role.draftId);
      if(payload.expected_revision !== record.contextContract.binding.revision || payload.expected_sequence !== (draft?.sequence ?? 0))throw new DraftConflictError("Requirement checkpoint changed");
      if(draft?.status === "abandoned" || role.chain === "planning" && draft?.status === "completed")throw new Error("Planning is finished; delivery publication and final review remain pending");
      if(draft?.runtimeInputs.some(item=>item.active && !item.answer))throw new Error("Answer all pending requirement questions first");
      if(payload.execution_resources && (payload.execution_resources.length !== 1 || payload.execution_resources.some(item=>repositoryCommonDirectory(item.path) !== repositoryCommonDirectory(record.repositoryPath) || item.mode === "in_place" && repositorySnapshot(item.path,false).repositoryPath !== record.repositoryPath)))throw new Error("Bind exactly one matching project repository");
      return {agent_id:role.agentId,revision:record.contextContract.binding.revision,sequence:draft?.sequence ?? 0};
    }
    if(action === "bind"){
      if(actor.kind !== "daemon" || actor.agentId !== role.agentId)throw new Error("Only the owning runtime can bind this requirement role");
      const payload=z.strictObject({work_dir:text,mode:z.enum(["in_place","worktree"]),overlays:z.array(z.strictObject({path:text,hash:text}))}).parse(request.payload),code=repositorySnapshot(payload.work_dir,false);
      if(repositoryCommonDirectory(code.repositoryPath) !== repositoryCommonDirectory(record.repositoryPath) || payload.mode === "in_place" && code.repositoryPath !== record.repositoryPath)throw new Error("Requirement execution belongs to another repository");
      const overlays=captureRepositoryOverlays(code.repositoryPath,payload.overlays,true),snapshot=repositorySnapshot(code.repositoryPath,true,overlays);
      if(snapshot.codeVersion !== role.contract.binding.codeVersion)throw new Error("Requirement execution is not at the frozen repository commit");
      this.db.prepare("INSERT INTO requirement_execution(workspace_id,issue_id,revision,agent_id,attempt_id,payload) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING").run(record.workspaceId,record.issueId,record.contextContract.binding.revision,actor.agentId,actor.attemptId,JSON.stringify({repositoryPath:code.repositoryPath,overlays}));return {bound:true,repository_path:code.repositoryPath};
    }
    if(actor.kind !== "human" && actor.kind !== "task")throw new Error("Authenticated requirement control is required");
    if(actor.kind === "task"){
      if(actor.agentId !== role.agentId)throw new Error("Task does not own the active requirement role");
      const row=this.db.prepare("SELECT payload FROM requirement_execution WHERE workspace_id=? AND issue_id=? AND revision=? AND agent_id=? AND attempt_id=?").get(record.workspaceId,record.issueId,record.contextContract.binding.revision,actor.agentId,actor.attemptId);
      if(!row)throw new Error("The runtime must bind its requirement repository first");const execution=executionSchema.parse(JSON.parse(String(row.payload))),code=repositorySnapshot(execution.repositoryPath,true,execution.overlays);
      if(code.codeVersion !== role.contract.binding.codeVersion)throw new Error("Requirement repository changed from its frozen snapshot");
    }
    const engine=new CommandChainEngine(this.drafts,role.chain === "context" ? createContextHandlers(record.contextContract) : createPlanningHandlers(record.planningContract!));let draft=await this.drafts.read(role.draftId);
    if(action === "start" && actor.kind === "task"){
      if(!draft)draft=await engine.create({id:role.draftId,chain:parseCommandChainDefinition(role.source,role.profile),binding:role.contract.binding,attemptId:actor.attemptId});
      else if(draft.status === "abandoned")throw new Error("Requirement draft was abandoned");
      else if(draft.status !== "completed" && draft.attemptId !== actor.attemptId)draft=await engine.resume(draft.id,draft.sequence,actor.attemptId);
    }else if(action !== "read"){
      if(!draft)throw new Error("Start the requirement draft first");
      if(action === "command" && actor.kind === "task"){const payload=z.strictObject({expected_sequence:sequence,command:chainCommandSchema}).parse(request.payload);draft=await engine.execute(draft.id,{expectedSequence:payload.expected_sequence,attemptId:actor.attemptId},payload.command);}
      else if(action === "answer" && actor.kind === "human"){const payload=z.strictObject({expected_sequence:sequence,request_id:text,answer:z.string().max(20000),selected_option:text.optional()}).parse(request.payload);draft=await engine.answerRuntimeInput(draft.id,{expectedSequence:payload.expected_sequence,requestId:payload.request_id,answer:payload.answer,userId:actor.userId,selectedOption:payload.selected_option});}
      else if(action === "abandon" && actor.kind === "human"){const payload=z.strictObject({expected_sequence:sequence,reason:text}).parse(request.payload);draft=await engine.abandon(draft.id,payload.expected_sequence,payload.reason,actor.userId);}
      else throw new Error("Operation is outside this authenticated requirement role");
    }
    const view=this.view(record,draft);
    if(actor.kind === "task" && draft?.status === "completed" && role.chain === "context")await this.settleContext(record,draft);
    return view;
  }
  private view(record:Record,draft?:ChainDraft){
    const role=this.role(record),phase=draft?.phase ? draft.definition.phases[draft.phase] : undefined;
    return {chain:role.chain,agentId:role.agentId,repositoryPath:record.repositoryPath,contract:role.contract,draft:draft ?? null,
      instructions:phase?.type === "builtin" ? `${phase.builtin}: Read the frozen inputs. Requirement acceptances use acceptance.put/remove only in their definition phase. ${decisionPolicies[record.contextContract.decisionMode]}` : phase?.instructions,
      decisionSchema:z.toJSONSchema(decisionProposalSchema),conclusion:draft?.status === "completed" ? role.chain === "context" ? compileContextConclusion(draft,record.contextContract) : compilePlanningConclusion(draft,record.planningContract!) : null,receipts:[]};
  }
}
