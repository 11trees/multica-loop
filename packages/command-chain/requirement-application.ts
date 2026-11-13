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
import { git, captureRepositoryOverlays, repositoryCommonDirectory, repositorySnapshot } from "./repository";
import { deliveryUnitSchema } from "./analysis";
import { verificationContractSchema } from "./verification";
import { reviewGapSources, compileReviewConclusion, createReviewHandlers, reviewContractSchema, reviewProfile, type ReviewContract } from "./review";
import type { compileAnalysisConclusion } from "./analysis";
import type { compileVerificationConclusion } from "./verification";
import { artifactBlock } from "./artifacts";
import { compileReproductionConclusion, reproductionState, createReproductionHandlers, reproductionContractSchema, reproductionProfile } from "./reproduction";

const text=z.string().trim().min(1),sequence=z.number().int().nonnegative();
const configuration=z.strictObject({kind:z.literal("requirement"),expected_revision:sequence,agent_id:z.uuid(),planner_agent_id:z.uuid(),reproduction_agent_id:z.uuid().optional(),repository_path:text,input:text.max(40000),item_kind:z.enum(["requirement","bug"]).default("requirement"),decision_mode:decisionModeSchema.default("balanced"),auto_continue:z.boolean().default(false)});
const acceptanceSchema=z.strictObject({id:z.uuid(),key:text,scope:z.literal("requirement"),statement:text,oracle:text,sourceRef:text,revision:z.number().int().positive(),active:z.boolean()});
const reviewUnitProof=z.strictObject({issue_id:z.uuid(),contract_hash:text,plan_draft_id:z.uuid(),parent_revision:z.number().int().positive(),unit_key:text});
const reviewRecordSchema=z.strictObject({agentId:z.uuid(),userId:z.uuid(),draftId:z.uuid(),source:text,contract:reviewContractSchema,units:z.array(reviewUnitProof).min(1),accepted:z.record(z.string(),verificationContractSchema.shape.binding),settled:z.boolean().default(false),reportHash:text.optional(),acknowledgement:z.strictObject({userId:z.uuid(),reportHash:text,sequence:sequence,acknowledgedAt:z.iso.datetime()}).optional()});
type DeliveryEvidence={binding:z.infer<typeof verificationContractSchema.shape.binding>;analysis:ReturnType<typeof compileAnalysisConclusion>;verification:ReturnType<typeof compileVerificationConclusion>};
const recordSchema=z.strictObject({workspaceId:z.uuid(),issueId:z.uuid(),createdBy:z.uuid(),repositoryPath:text,agentId:z.uuid(),plannerAgentId:z.uuid(),autoContinue:z.boolean(),contextDraftId:z.uuid(),planDraftId:z.uuid(),contextSource:text,planningSource:text,contextContract:contextContractSchema,contextHandoff:z.boolean(),planningContract:planningContractSchema.optional(),reproduction:z.strictObject({agentId:z.uuid(),draftId:z.uuid(),source:text,contract:reproductionContractSchema.optional(),handoff:z.boolean()}).optional(),acceptances:z.array(acceptanceSchema).default([]),publicationRequestedBy:z.uuid().optional(),deliveryPolicy:z.strictObject({analystId:z.uuid(),developerId:z.uuid(),verifierId:z.uuid(),maxReworks:sequence.max(10),mode:z.enum(["in_place","worktree"]),userId:z.uuid()}).optional(),accepted:z.record(z.string(),verificationContractSchema.shape.binding).default({}),reviews:z.array(reviewRecordSchema).default([])});
type Record=z.infer<typeof recordSchema>;
type ReviewRecord=z.infer<typeof reviewRecordSchema>;
const managedUnitSchema=z.strictObject({workspaceId:z.uuid(),issueId:z.uuid(),parentIssueId:z.uuid(),parentRevision:z.number().int().positive(),planDraftId:z.uuid(),planSequence:sequence,unit:deliveryUnitSchema,sources:verificationContractSchema.shape.sources,contractHash:text,published:z.boolean()});
const executionSchema=z.strictObject({repositoryPath:text,overlays:z.array(z.strictObject({path:text,hash:text,executable:z.boolean(),originalHash:text.nullable(),originalExecutable:z.boolean()}))});
export type RequirementDefinitions={context:string;planning:string;review?:string;reproduction?:string};

function stableId(value:string){const hash=createHash("sha256").update(value).digest("hex");return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;}

/** Requirement-level checkpoints share the authenticated host and draft store. */
export class RequirementApplication {
  constructor(private readonly db:DatabaseSync,private readonly drafts:SqliteDraftStore,private readonly definitions?:RequirementDefinitions,private readonly deliveryEvidence?:(workspaceId:string,issueId:string)=>Promise<DeliveryEvidence>){
    db.exec("CREATE TABLE IF NOT EXISTS requirement_contract (workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id,revision))");
    db.exec("CREATE TABLE IF NOT EXISTS requirement_acceptance (workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,acceptance_key TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id,acceptance_key,revision))");
    db.exec("CREATE TABLE IF NOT EXISTS requirement_execution (workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,revision INTEGER NOT NULL,agent_id TEXT NOT NULL,attempt_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id,revision,agent_id,attempt_id))");
    db.exec("CREATE TABLE IF NOT EXISTS requirement_unit (workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,parent_issue_id TEXT NOT NULL,unit_index INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id))");
    if(definitions){parseCommandChainDefinition(definitions.context,contextProfile);parseCommandChainDefinition(definitions.planning,planningProfile);if(definitions.reproduction)parseCommandChainDefinition(definitions.reproduction,reproductionProfile);if(definitions.review)parseCommandChainDefinition(definitions.review,reviewProfile);}
  }
  current(workspaceId:string,issueId:string){const row=this.db.prepare("SELECT payload FROM requirement_contract WHERE workspace_id=? AND issue_id=? ORDER BY revision DESC LIMIT 1").get(workspaceId,issueId);return row ? recordSchema.parse(JSON.parse(String(row.payload))) : undefined;}
  managedUnit(workspaceId:string,issueId:string){const row=this.db.prepare("SELECT payload FROM requirement_unit WHERE workspace_id=? AND issue_id=?").get(workspaceId,issueId);return row ? managedUnitSchema.parse(JSON.parse(String(row.payload))) : undefined;}
  async deliveryPolicy(request:ApplicationRequest){
    if(request.actor.kind !== "human")throw new Error("Only a human can authorize requirement execution");
    const record=this.current(request.actor.workspaceId,request.actor.issueId);if(!record)throw new Error("Requirement is not configured");
    const payload=z.strictObject({expected_revision:sequence,expected_sequence:sequence,analyst_agent_id:z.uuid(),developer_agent_id:z.uuid(),agent_id:z.uuid(),max_reworks:sequence.max(10),execution_resources:z.array(z.strictObject({path:text,mode:z.enum(["in_place","worktree"])})).length(3)}).parse(request.payload);
    const draft=await this.drafts.read(record.planDraftId),units=this.publication(record).units;
    if(payload.expected_revision !== record.contextContract.binding.revision || payload.expected_sequence !== draft?.sequence)throw new DraftConflictError("Requirement plan changed before delivery authorization");
    if(!record.publicationRequestedBy || !units.length || units.some(unit=>!unit.published) || !draft || !record.planningContract)throw new Error("Publish every planned unit before authorizing delivery");
    compilePlanningConclusion(draft,record.planningContract);
    if(new Set([payload.analyst_agent_id,payload.developer_agent_id,payload.agent_id]).size !== 3)throw new Error("Analysis, development and verification require separate agents");
    const mode=payload.execution_resources[0]!.mode;
    if(payload.execution_resources.some(resource=>resource.mode !== mode || repositoryCommonDirectory(resource.path) !== repositoryCommonDirectory(record.repositoryPath) || repositorySnapshot(resource.path,false).repositoryPath !== record.repositoryPath))throw new Error("All delivery roles must use the same registered project repository and execution mode");
    const policy={analystId:payload.analyst_agent_id,developerId:payload.developer_agent_id,verifierId:payload.agent_id,maxReworks:payload.max_reworks,mode,userId:request.actor.userId};
    if(record.deliveryPolicy && JSON.stringify(record.deliveryPolicy) !== JSON.stringify(policy))throw new Error("Delivery policy is frozen for this published plan");
    record.deliveryPolicy=policy;this.save(record);return {authorized:true};
  }
  executionContext(workspaceId:string,issueId:string){
    const unit=this.managedUnit(workspaceId,issueId);if(!unit)return;
    const parent=this.current(workspaceId,unit.parentIssueId);if(!parent?.deliveryPolicy || parent.contextContract.binding.revision !== unit.parentRevision || parent.planDraftId !== unit.planDraftId)throw new Error("Managed unit has no current authorized parent execution");
    const units=this.publication(parent).units,index=units.findIndex(item=>item.issueId === issueId);
    if(!unit.published || index<0 || units.slice(0,index).some(item=>!parent.accepted[item.unit.key]))throw new Error("Managed unit must wait for preceding verified deliveries");
    return {unit,parent,policy:parent.deliveryPolicy,units,index};
  }
  async acceptUnit(request:ApplicationRequest,binding:unknown){
    if(request.actor.kind !== "host")throw new Error("Only the host can accept verified native delivery");
    const context=this.executionContext(request.actor.workspaceId,request.actor.issueId);if(!context)throw new Error("Managed unit is unavailable");
    const value=verificationContractSchema.shape.binding.parse(binding);
    if(value.workspaceId !== context.unit.workspaceId || value.issueId !== context.unit.issueId)throw new Error("Verification belongs to another managed unit");
    const existing=context.parent.accepted[context.unit.unit.key];if(existing && JSON.stringify(existing) !== JSON.stringify(value))throw new DraftConflictError("Accepted delivery version changed");
    context.parent.accepted[context.unit.unit.key]=value;this.save(context.parent);return {accepted:true};
  }
  executionPlans(){return this.db.prepare("SELECT r.payload FROM requirement_contract r WHERE revision=(SELECT MAX(v.revision) FROM requirement_contract v WHERE v.workspace_id=r.workspace_id AND v.issue_id=r.issue_id)").all().map(row=>recordSchema.parse(JSON.parse(String(row.payload)))).filter(record=>record.deliveryPolicy).map(parent=>({parent,units:this.publication(parent).units}));}
  reviewUnits(record:Record){return this.publication(record).units.map(item=>({issue_id:item.issueId,contract_hash:item.contractHash,plan_draft_id:item.planDraftId,parent_revision:item.parentRevision,unit_key:item.unit.key}));}
  private async reviewFacts(record:Record,beforeGeneration=Infinity){
    const units=this.publication(record).units;
    if(!record.deliveryPolicy || !units.length || units.some(item=>!item.published || !record.accepted[item.unit.key]) || !this.deliveryEvidence)throw new Error("Final review requires every published unit's accepted independent verification");
    const evidence:ReviewContract["evidence"]=[],proofs=new Map<string,string>();
    const add=(ref:string,kind:string,revision:number,value:unknown,independentTest=false)=>{
      const content=JSON.stringify(value);evidence.push({ref,kind,revision:String(revision),status:independentTest ? "passed" : "completed",fingerprint:createHash("sha256").update(content).digest("hex"),independentTest,content});return ref;
    };
    const contextDraft=await this.drafts.read(record.contextDraftId);if(!contextDraft)throw new Error("Requirement context is missing");
    const context=compileContextConclusion(contextDraft,record.contextContract);add(`REQUIREMENT_CONTEXT:${contextDraft.id}`,"requirement-context",record.contextContract.binding.revision,context);
    if(record.reproduction?.handoff){const draft=await this.drafts.read(record.reproduction.draftId);if(!draft)throw new Error("Reproduction evidence is missing");await this.validateReproduction(record);add(`REPRODUCTION:${draft.id}`,"reproduction",draft.binding.revision,compileReproductionConclusion(draft,record.reproduction.contract!));}
    for(const item of units){
      const value=await this.deliveryEvidence(record.workspaceId,item.issueId);
      if(JSON.stringify(value.binding) !== JSON.stringify(record.accepted[item.unit.key]))throw new DraftConflictError("Accepted unit verification changed before requirement review");
      add(`DELIVERY_SPEC:${value.analysis.draftId}`,"delivery-spec",value.analysis.binding.revision,value.analysis);
      const ref=add(`VERIFICATION:${value.verification.draftId}:r${value.binding.revision}`,"independent-verification",value.binding.revision,value.verification,true);proofs.set(item.unit.key,ref);
    }
    for(const review of record.reviews.filter(item=>item.contract.generation<beforeGeneration)){const draft=await this.drafts.read(review.draftId);if(draft?.status === "completed")add(`REVIEW:${draft.id}:r${review.contract.generation}`,"review-history",review.contract.generation,compileReviewConclusion(draft,review.contract));}
    const all=units.map(item=>proofs.get(item.unit.key)!);
    const subjects:ReviewContract["subjects"]=[{key:`REQUIREMENT_CONTEXT:${contextDraft.id}:intent`,kind:"intent",content:context.intent,sourceRef:`REQUIREMENT_CONTEXT:${contextDraft.id}:intent`,requiredEvidenceRefs:all}];
    for(const item of context.assertions.filter(item=>item.perspective === "target" || record.contextContract.kind === "bug" && item.perspective === "expected" && !["inferred","conflicted"].includes(item.evidence)))subjects.push({key:`REQUIREMENT_CONTEXT:${contextDraft.id}:assertion:${item.key}`,kind:item.perspective === "expected" ? "expected" : "target",content:item.statement,sourceRef:item.source,requiredEvidenceRefs:all});
    for(const item of context.impacts)subjects.push({key:`REQUIREMENT_CONTEXT:${contextDraft.id}:impact:${item.key}`,kind:"impact",content:`[${item.disposition}] ${item.statement}\n${item.rationale}`,sourceRef:item.source,requiredEvidenceRefs:all});
    for(const acceptance of record.acceptances){
      const ref=`ACCEPTANCE:${acceptance.id}:r${acceptance.revision}`,relevant=units.filter(item=>item.sources.some(source=>source.sourceRef === ref));
      if(!relevant.length)throw new Error(`Requirement acceptance ${acceptance.key} has no delivered verification scope`);
      subjects.push({key:ref,kind:"acceptance",content:`${acceptance.statement}\nOracle: ${acceptance.oracle}`,sourceRef:ref,requiredEvidenceRefs:relevant.map(item=>proofs.get(item.unit.key)!)});
    }
    for(const [index,item] of units.entries())subjects.push({key:`DELIVERY_UNIT:${item.issueId}`,kind:"delivery_unit",content:JSON.stringify({key:item.unit.key,title:item.unit.title,actor:item.unit.actor,trigger:item.unit.trigger,observableOutcome:item.unit.observableOutcome,acceptance:item.unit.acceptance}),contractRef:item.contractHash,storyIndex:String(index+1),requiredEvidenceRefs:[proofs.get(item.unit.key)!]});
    const last=record.accepted[units.at(-1)!.unit.key]!;
    for(const value of Object.values(record.accepted))git(record.repositoryPath,["merge-base","--is-ancestor",value.codeVersion,last.codeVersion]);
    return {subjects,evidence,codeVersion:last.codeVersion,units:this.reviewUnits(record)};
  }
  private async validateReview(record:Record,review:ReviewRecord){
    const facts=await this.reviewFacts(record,review.contract.generation);
    const expected=reviewContractSchema.parse({...review.contract,subjects:facts.subjects,evidence:facts.evidence});
    if(JSON.stringify(expected.subjects) !== JSON.stringify(review.contract.subjects) || JSON.stringify(expected.evidence) !== JSON.stringify(review.contract.evidence) || JSON.stringify(facts.units) !== JSON.stringify(review.units) || facts.codeVersion !== review.contract.binding.codeVersion || JSON.stringify(record.accepted) !== JSON.stringify(review.accepted))throw new DraftConflictError("Frozen requirement review facts or accepted versions changed");
  }
  private readonlyExecution(record:Record,review:{agentId:string;contract:{binding:ChainDraft["binding"]}},draft:ChainDraft){
    const row=this.db.prepare("SELECT payload FROM requirement_execution WHERE workspace_id=? AND issue_id=? AND revision=? AND agent_id=? AND attempt_id=?").get(record.workspaceId,record.issueId,record.contextContract.binding.revision,review.agentId,draft.attemptId);
    if(!row)throw new Error("Read-only requirement runtime repository is unavailable");
    const execution=executionSchema.parse(JSON.parse(String(row.payload))),code=repositorySnapshot(execution.repositoryPath,true,execution.overlays);
    if(code.codeVersion !== review.contract.binding.codeVersion)throw new DraftConflictError("Read-only requirement repository changed from its frozen commit");
    return execution;
  }
  private async configureReview(record:Record,request:ApplicationRequest){
    if(request.actor.kind !== "human" || !this.definitions?.review)throw new Error("Only a human can configure the requirement reviewer");
    const input=z.strictObject({expected_revision:sequence,expected_sequence:sequence,agent_id:z.uuid(),execution_resources:z.array(z.strictObject({path:text,mode:z.enum(["in_place","worktree"])})).length(1),native_unit_ids:z.array(z.uuid()).min(1)}).parse(request.payload);
    const role=this.role(record),previousDraft=await this.drafts.read(role.draftId);
    if(input.expected_revision !== record.contextContract.binding.revision || input.expected_sequence !== (previousDraft?.sequence ?? 0))throw new DraftConflictError("Requirement review checkpoint changed");
    if(!previousDraft || !["completed","abandoned"].includes(previousDraft.status))throw new Error("Finish or abandon the current requirement draft before starting a review");
    const previous=record.reviews.at(-1);
    if(previousDraft.status === "completed" && previous && compileReviewConclusion(previousDraft,previous.contract).verdict === "report_ready")throw new Error("Read the current closure report; a completed report cannot be silently replaced");
    const policy=record.deliveryPolicy;if(!policy || [policy.analystId,policy.developerId,policy.verifierId].includes(input.agent_id))throw new Error("Requirement review needs a separate agent from analysis, development and verification");
    const resource=input.execution_resources[0]!;
    if(resource.mode !== policy.mode || repositorySnapshot(resource.path,false).repositoryPath !== record.repositoryPath)throw new Error("Reviewer must use the frozen registered repository and execution mode");
    const facts=await this.reviewFacts(record);
    if(JSON.stringify(input.native_unit_ids) !== JSON.stringify(facts.units.map(item=>item.issue_id)))throw new DraftConflictError("Native delivered unit scope changed before review");
    if(policy.mode === "in_place" && repositorySnapshot(record.repositoryPath).codeVersion !== facts.codeVersion)throw new DraftConflictError("Final in-place repository must match the last accepted unit commit");
    const generation=record.reviews.length+1,contract=reviewContractSchema.parse({binding:{workspaceId:record.workspaceId,issueId:record.issueId,revision:record.contextContract.binding.revision,codeVersion:facts.codeVersion,contractVersion:createHash("sha256").update(JSON.stringify({generation,...facts})).digest("hex")},generation,subjects:facts.subjects,evidence:facts.evidence});
    const review=reviewRecordSchema.parse({agentId:input.agent_id,userId:request.actor.userId,draftId:randomUUID(),source:this.definitions.review,contract,units:facts.units,accepted:record.accepted});
    this.db.exec("BEGIN IMMEDIATE");try{if(this.current(record.workspaceId,record.issueId)!.reviews.length !== record.reviews.length)throw new DraftConflictError("Review generation changed");record.reviews.push(review);this.save(record);this.db.exec("COMMIT");}catch(error){this.db.exec("ROLLBACK");throw error;}
    return {configured:true};
  }
  private async settleReview(record:Record,draft:ChainDraft){
    const review=record.reviews.at(-1)!;if(review.settled)return;
    await this.validateReview(record,review);this.readonlyExecution(record,review,draft);
    const conclusion=compileReviewConclusion(draft,review.contract),existing=this.publication(record).units;
    const ordered:typeof conclusion.units=[];
    while(ordered.length<conclusion.units.length){const next=conclusion.units.find(item=>!ordered.includes(item) && item.dependsOn.every(key=>ordered.some(unit=>unit.key === key)));if(!next)throw new Error("Review forward units cannot be ordered");ordered.push(next);}
    const keys=new Map(ordered.map(item=>[item.key,`review:${createHash("sha256").update(`${draft.id}:${item.key}`).digest("hex").slice(0,28)}`]));
    const acceptances=conclusion.gaps.map(gap=>acceptanceSchema.parse({id:stableId(`multica:review-gap:${draft.id}:${gap.key}`),key:`review-gap:${createHash("sha256").update(`${draft.id}:${gap.key}`).digest("hex").slice(0,28)}`,scope:"requirement",statement:gap.reason,oracle:gap.boundary,sourceRef:`REVIEW_GAP:${draft.id}:${gap.key}`,revision:1,active:true}));
    const units=ordered.map(value=>{
      const gaps=conclusion.gaps.filter(gap=>value.gapKeys.includes(gap.key)),sourceRefs=reviewGapSources(review.contract.subjects,gaps,draft.id);
      const sources: z.infer<typeof verificationContractSchema.shape.sources>=gaps.map(gap=>({key:`gap:${createHash("sha256").update(gap.key).digest("hex").slice(0,24)}`,kind:"acceptance",description:gap.reason,oracle:gap.boundary,sourceRef:`ACCEPTANCE:${acceptances.find(item=>item.sourceRef === `REVIEW_GAP:${draft.id}:${gap.key}`)!.id}:r1`}));
      for(const gap of gaps){const acceptance=record.acceptances.find(item=>`ACCEPTANCE:${item.id}:r${item.revision}` === gap.subjectRef);if(acceptance)sources.push({key:`original:${acceptance.id}`,kind:"acceptance",description:acceptance.statement,oracle:acceptance.oracle,sourceRef:gap.subjectRef});}
      sources.push({key:`unit:${keys.get(value.key)!.slice(7)}`,kind:"acceptance",description:value.acceptance,oracle:value.acceptance,sourceRef:`REVIEW_UNIT:${draft.id}:${value.key}`});
      const unit={key:keys.get(value.key)!,title:value.title,actor:value.actor,trigger:value.trigger,observableOutcome:value.observableOutcome,acceptance:value.acceptance,sourceRefs,dependsOn:value.dependsOn.map(key=>keys.get(key)!)};
      const snapshot={workspaceId:record.workspaceId,issueId:stableId(`multica:review-unit:${draft.id}:${value.key}`),parentIssueId:record.issueId,parentRevision:record.contextContract.binding.revision,planDraftId:record.planDraftId,planSequence:existing[0]!.planSequence,unit,sources,published:false};return managedUnitSchema.parse({...snapshot,contractHash:createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")});
    });
    this.db.exec("BEGIN IMMEDIATE");try{
      const current=this.current(record.workspaceId,record.issueId)!;if(current.reviews.at(-1)?.draftId !== draft.id)throw new DraftConflictError("Review generation changed before publication");if(current.reviews.at(-1)!.settled){this.db.exec("COMMIT");return;}
      for(const [index,unit] of units.entries())this.db.prepare("INSERT INTO requirement_unit(workspace_id,issue_id,parent_issue_id,unit_index,payload) VALUES(?,?,?,?,?)").run(record.workspaceId,unit.issueId,record.issueId,existing.length+index,JSON.stringify(unit));
      for(const acceptance of acceptances)this.db.prepare("INSERT INTO requirement_acceptance(workspace_id,issue_id,acceptance_key,revision,payload) VALUES(?,?,?,?,?)").run(record.workspaceId,record.issueId,acceptance.key,acceptance.revision,JSON.stringify(acceptance));
      record.acceptances.push(...acceptances);
      review.settled=true;if(conclusion.report)review.reportHash=createHash("sha256").update(JSON.stringify(conclusion)).digest("hex");this.save(record);this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  private async reviewCompletion(record:Record){
    const review=record.reviews.at(-1);if(!review)throw new DraftConflictError("Requirement delivery and final review must complete; a context or plan is not delivered work");
    await this.validateReview(record,review);const draft=await this.drafts.read(review.draftId);if(!draft)throw new DraftConflictError("Requirement final review is incomplete");
    this.readonlyExecution(record,review,draft);const result=compileReviewConclusion(draft,review.contract);
    if(result.verdict !== "report_ready" || !review.settled || !review.reportHash)throw new DraftConflictError("Requirement final review has unresolved closure gaps");
    return {review,draft,result};
  }
  private async acknowledgeReview(record:Record,request:ApplicationRequest){
    if(request.actor.kind !== "human")throw new Error("Only the authenticated human can acknowledge reading the report");
    const payload=z.strictObject({expected_revision:sequence,expected_sequence:sequence,report_hash:text}).parse(request.payload),{review,draft}=await this.reviewCompletion(record);
    if(payload.expected_revision !== record.contextContract.binding.revision || payload.expected_sequence !== draft.sequence || payload.report_hash !== review.reportHash)throw new DraftConflictError("Read the current closure report before acknowledging");
    review.acknowledgement ??= {userId:request.actor.userId,reportHash:review.reportHash!,sequence:draft.sequence,acknowledgedAt:new Date().toISOString()};this.save(record);return {acknowledged:true};
  }
  private publication(record:Record){return {requested_by:record.publicationRequestedBy ?? null,units:this.db.prepare("SELECT payload FROM requirement_unit WHERE workspace_id=? AND parent_issue_id=? ORDER BY unit_index").all(record.workspaceId,record.issueId).map(row=>managedUnitSchema.parse(JSON.parse(String(row.payload))))};}
  private async publish(record:Record,request:ApplicationRequest){
    if(request.actor.kind !== "human")throw new Error("Only a human can publish planned delivery units");
    const expected=z.strictObject({expected_revision:sequence,expected_sequence:sequence}).parse(request.payload),draft=await this.drafts.read(record.planDraftId);
    if(record.contextContract.kind === "bug" && !record.reproduction?.handoff)throw new Error("Reproduce the bug before delivery publication");
    if(expected.expected_revision !== record.contextContract.binding.revision || expected.expected_sequence !== (await this.drafts.read(this.role(record).draftId))?.sequence)throw new DraftConflictError("Requirement plan changed; reload before publication");
    if(!record.contextHandoff || !draft || !record.planningContract)throw new Error("Complete requirement planning before publication");
    const plan=compilePlanningConclusion(draft,record.planningContract);
    if(record.publicationRequestedBy){if(record.publicationRequestedBy !== request.actor.userId)throw new Error("Resume publication as its original human owner");return this.publication(record);}
    const units=plan.units.map(unit=>{
      const sources=unit.sourceRefs.filter(source=>source.kind === "acceptance").map(source=>{
        const oracle=record.planningContract!.sources.find(item=>item.key === source.key)!.oracle;if(!oracle)throw new Error("Requirement acceptance is missing its original oracle");
        return {key:source.key.length<=120 ? source.key : `source:${createHash("sha256").update(source.key).digest("hex").slice(0,24)}`,kind:"acceptance" as const,description:source.content,oracle,sourceRef:source.sourceRef};
      });
      sources.push({key:`unit:${createHash("sha256").update(`${draft.id}:${unit.key}`).digest("hex").slice(0,20)}`,kind:"acceptance",description:unit.acceptance,oracle:unit.acceptance,sourceRef:`DELIVERY_PLAN:${draft.id}:unit:${unit.key}`});
      const value={workspaceId:record.workspaceId,issueId:stableId(`multica:delivery-unit:${record.issueId}:${draft.id}:${unit.key}`),parentIssueId:record.issueId,parentRevision:record.contextContract.binding.revision,planDraftId:draft.id,planSequence:draft.sequence,unit,sources,published:false};
      return managedUnitSchema.parse({...value,contractHash:createHash("sha256").update(JSON.stringify(value)).digest("hex")});
    });
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const current=this.current(record.workspaceId,record.issueId)!;if(current.contextContract.binding.revision !== expected.expected_revision || current.publicationRequestedBy)throw new DraftConflictError("Requirement publication changed");
      record.publicationRequestedBy=request.actor.userId;this.save(record);
      for(const [index,unit] of units.entries())this.db.prepare("INSERT INTO requirement_unit(workspace_id,issue_id,parent_issue_id,unit_index,payload) VALUES(?,?,?,?,?)").run(record.workspaceId,unit.issueId,record.issueId,index,JSON.stringify(unit));
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    return this.publication(record);
  }
  private save(record:Record){this.db.prepare("UPDATE requirement_contract SET payload=? WHERE workspace_id=? AND issue_id=? AND revision=?").run(JSON.stringify(record),record.workspaceId,record.issueId,record.contextContract.binding.revision);}
  private role(record:Record){
    if(record.contextHandoff && record.contextContract.kind === "bug" && !record.reproduction)throw new Error("Reconfigure this bug with a reproduction agent before planning");
    const reproduction=record.reproduction;
    if(record.contextHandoff && reproduction && !reproduction.handoff){if(!reproduction.contract)throw new Error("Reproduction inputs are unavailable");return {chain:"reproduction",agentId:reproduction.agentId,draftId:reproduction.draftId,contract:reproduction.contract,source:reproduction.source,profile:reproductionProfile};}
    const review=record.reviews.at(-1);return review ? {chain:"review",agentId:review.agentId,draftId:review.draftId,contract:review.contract,source:review.source,profile:reviewProfile} : record.contextHandoff ? {chain:"planning",agentId:record.plannerAgentId,draftId:record.planDraftId,contract:record.planningContract!,source:record.planningSource,profile:planningProfile} : {chain:"context",agentId:record.agentId,draftId:record.contextDraftId,contract:record.contextContract,source:record.contextSource,profile:contextProfile};}
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
    if(record.reproduction){
      const content=JSON.stringify(conclusion),fingerprint=createHash("sha256").update(content).digest("hex");
      record.reproduction.contract=reproductionContractSchema.parse({binding:{...record.contextContract.binding,contractVersion:fingerprint},decisionMode:record.contextContract.decisionMode,contextRef:`REQUIREMENT_CONTEXT:${draft.id}`,contextFingerprint:fingerprint,contextContent:content,expectedBehavior:conclusion.assertions.filter(item=>item.perspective === "expected" && !["inferred","conflicted"].includes(item.evidence)).map(item=>item.statement).join("\n")});
    }
    record.acceptances=active;record.contextHandoff=true;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      if(this.current(record.workspaceId,record.issueId)!.contextContract.binding.revision !== record.contextContract.binding.revision)throw new DraftConflictError("Requirement revision changed before context handoff");
      for(const item of [...active,...retired])this.db.prepare("INSERT INTO requirement_acceptance(workspace_id,issue_id,acceptance_key,revision,payload) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING").run(record.workspaceId,record.issueId,item.key,item.revision,JSON.stringify(item));
      this.save(record);this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  private async validateReproduction(record:Record){
    const reproduction=record.reproduction;if(!reproduction?.contract)throw new Error("Frozen reproduction inputs are unavailable");
    const context=await this.drafts.read(record.contextDraftId);if(!context)throw new Error("Reproduction context is missing");
    const content=JSON.stringify(compileContextConclusion(context,record.contextContract));
    if(content !== reproduction.contract.contextContent || createHash("sha256").update(content).digest("hex") !== reproduction.contract.contextFingerprint)throw new DraftConflictError("Frozen reproduction context changed");
  }
  private async settleReproduction(record:Record,draft:ChainDraft){
    const reproduction=record.reproduction!;if(reproduction.handoff)return;
    await this.validateReproduction(record);this.readonlyExecution(record,{agentId:reproduction.agentId,contract:reproduction.contract!},draft);
    const result=compileReproductionConclusion(draft,reproduction.contract!),parts=[{kind:"preserve" as const,value:result.verdict!.expectedBehavior},...[
      {verdict:result.verdict},...result.steps.map(step=>({step})),...result.evidence.map(evidence=>({evidence})),
    ].map(value=>({kind:"change" as const,value:JSON.stringify(value)}))];
    const sources=parts.flatMap((part,index)=>Array.from({length:Math.ceil(part.value.length/4000)},(_,chunk)=>({key:`reproduction:${index}:${chunk}`,kind:part.kind,content:part.value.slice(chunk*4000,(chunk+1)*4000),sourceRef:`REPRODUCTION:${draft.id}:r${draft.binding.revision}`})));
    const planning={...record.planningContract!,sources:[...record.planningContract!.sources,...sources],reproduction:{draftId:draft.id,sequence:draft.sequence,codeVersion:result.binding.codeVersion,report:result.report},binding:{...record.planningContract!.binding,contractVersion:createHash("sha256").update(JSON.stringify({context:record.planningContract,result})).digest("hex")}};
    record.planningContract=planningContractSchema.parse(planning);reproduction.handoff=true;
    this.db.exec("BEGIN IMMEDIATE");try{
      const current=this.current(record.workspaceId,record.issueId)!;
      if(current.contextContract.binding.revision !== record.contextContract.binding.revision || current.reproduction?.draftId !== draft.id)throw new DraftConflictError("Reproduction generation changed before handoff");
      if(!current.reproduction.handoff)this.save(record);this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  async overview(record:Record){
    const role=this.role(record),draft=await this.drafts.read(role.draftId),contextDraft=record.contextHandoff ? await this.drafts.read(record.contextDraftId) : undefined;
    const context=contextDraft ? compileContextConclusion(contextDraft,record.contextContract) : null;
    const planningDraft=record.contextHandoff ? await this.drafts.read(record.planDraftId) : undefined;
    const reproductionDraft=record.reproduction ? await this.drafts.read(record.reproduction.draftId) : undefined;
    const reproductionResult=reproductionDraft?.status === "completed" ? compileReproductionConclusion(reproductionDraft,record.reproduction!.contract!) : null;
    const plan=planningDraft?.status === "completed" ? compilePlanningConclusion(planningDraft,record.planningContract!) : null;
    const review=record.reviews.at(-1),reviewResult=review && draft?.status === "completed" ? compileReviewConclusion(draft,review.contract) : null;
    return {enabled:true,configured:true,auto_continue:record.autoContinue || !!record.reviews.length,chain:role.chain,agent_id:role.agentId,revision:record.contextContract.binding.revision,sequence:draft?.sequence ?? 0,code_version:role.contract.binding.codeVersion,repository_path:record.repositoryPath,draft_id:draft?.id ?? null,status:draft?.status ?? "unstarted",current_phase:draft?.phase ?? null,
      phases:Object.keys(parseCommandChainDefinition(role.source,role.profile).definition.phases).map(id=>({id,status:draft?.completedPhases.includes(id) ? "completed" : id === draft?.phase ? "current" : "pending"})),
      sources:record.planningContract?.sources.map(item=>({key:item.key,kind:item.kind,description:item.content,oracle:item.oracle ?? item.content,source_ref:item.sourceRef})) ?? [],
      artifacts:draft?.artifacts.map(item=>({...item,title:artifactBlock(draft.definition,item.ref).title})) ?? [],decisions:draft?.decisions ?? contextDraft?.decisions ?? [],
      questions:[...(contextDraft?.runtimeInputs.map(item=>({...item,active:false})) ?? []),...(draft?.runtimeInputs ?? [])].map(item=>({...item,decision_key:item.decisionKey,recommendation_option:item.recommendationOption,answer:item.answer ? {text:item.answer.text,user_id:item.answer.userId,sequence:item.answer.sequence,selected_option:item.answer.selectedOption} : null})),
      requirement:{reproduction:record.reproduction ? {agent_id:record.reproduction.agentId,draft_id:record.reproduction.draftId,status:reproductionDraft?.status ?? "unstarted",observation:reproductionDraft ? reproductionState(reproductionDraft).verdict ?? null : null,result:reproductionResult ? {verdict:"reproduced",report:reproductionResult.report,code_version:reproductionResult.binding.codeVersion} : null} : null,kind:record.contextContract.kind,input:record.contextContract.input,context:context ? {intent:context.intent,changeSummary:context.changeSummary,acceptances:record.acceptances} : null,plan,review_enabled:!!this.definitions?.review,delivery_units:this.publication(record).units.map(item=>item.unit),review:review ? {generation:review.contract.generation,draft_id:review.draftId,agent_id:review.agentId,report_hash:review.reportHash ?? null,acknowledgement:review.acknowledgement ?? null,result:reviewResult,history:await Promise.all(record.reviews.slice(0,-1).map(async item=>{const previous=await this.drafts.read(item.draftId);return {generation:item.contract.generation,draft_id:item.draftId,code_version:item.contract.binding.codeVersion,result:previous?.status === "completed" ? compileReviewConclusion(previous,item.contract) : null};}))} : null,delivery_policy:record.deliveryPolicy ?? null,accepted:record.accepted,publication:record.publicationRequestedBy ? this.publication(record) : null},result:null,
    };
  }
  async continuations(){
    const rows=this.db.prepare("SELECT r.payload FROM requirement_contract r WHERE revision=(SELECT MAX(v.revision) FROM requirement_contract v WHERE v.workspace_id=r.workspace_id AND v.issue_id=r.issue_id)").all(),pending=[];
    for(const row of rows){const record=recordSchema.parse(JSON.parse(String(row.payload)));
      if(!record.contextHandoff){const draft=await this.drafts.read(record.contextDraftId);if(draft?.status === "completed")await this.settleContext(record,draft);}
      if(record.reproduction?.contract && !record.reproduction.handoff){const reproductionDraft=await this.drafts.read(record.reproduction.draftId);if(reproductionDraft?.status === "completed")await this.settleReproduction(record,reproductionDraft);}
      if(!record.autoContinue && !record.reviews.length)continue;
      const role=this.role(record),draft=await this.drafts.read(role.draftId),review=record.reviews.at(-1);
      if(review && draft?.status === "completed" && !review.settled)await this.settleReview(record,draft);
      const result=review && draft?.status === "completed" ? compileReviewConclusion(draft,review.contract) : null,units=this.publication(record).units;
      const reason=role.chain === "reproduction" && !draft ? "reproduction_handoff" : role.chain === "review" && !draft ? "review_ready" : result?.verdict === "closure_gap" && units.some(item=>!item.published) ? "review_forward" : result?.verdict === "closure_gap" && units.every(item=>record.accepted[item.unit.key]) ? "review_next" : role.chain === "planning" && !draft ? "context_handoff" : draft?.status === "waiting_for_answers" && draft.runtimeInputs.some(item=>item.active) && draft.runtimeInputs.every(item=>!item.active || item.answer) ? "human_answers" : null;
      if(reason)pending.push({workspace_id:record.workspaceId,issue_id:record.issueId,agent_id:role.agentId,user_id:review?.userId ?? record.createdBy,task_id:stableId(`multica:engineering:continuation:${role.draftId}:${draft?.sequence ?? 0}`),expected_revision:record.contextContract.binding.revision,expected_sequence:draft?.sequence ?? 0,reason});
    }return pending;
  }
  async invoke(request:ApplicationRequest){
    const {actor,action}=request;if(actor.kind === "coordinator")throw new Error("Use the requirement continuation coordinator");
    let record=this.current(actor.workspaceId,actor.issueId);
    if(action === "configure"){
      if(actor.kind !== "human")throw new Error("Only a human can freeze requirement inputs");
      const config=configuration.parse(request.payload);if(!this.definitions)throw new Error("Requirement definitions are unavailable");
      if(config.item_kind === "bug" && (!config.reproduction_agent_id || !this.definitions.reproduction))throw new Error("Bug Fix requires a reproduction agent and definition");
      if(config.item_kind === "requirement" && config.reproduction_agent_id)throw new Error("Reproduction is only configured for Bug Fix");
      if(config.reproduction_agent_id && [config.agent_id,config.planner_agent_id].includes(config.reproduction_agent_id))throw new Error("Reproduction requires a separate agent from context and planning");
      if(config.agent_id === config.planner_agent_id)throw new Error("Context and planning require separate agents");
      if(config.expected_revision !== (record?.contextContract.binding.revision ?? 0))throw new DraftConflictError("Requirement revision changed; reload before configuring");
      if(record?.publicationRequestedBy)throw new Error("Published unit bindings must be reconciled before replacing this requirement plan");
      if(record){const draft=await this.drafts.read(this.role(record).draftId);if(draft && !["completed","abandoned"].includes(draft.status))throw new Error("Abandon the active requirement draft before replacing its input");}
      const code=repositorySnapshot(config.repository_path),revision=config.expected_revision+1;
      record=recordSchema.parse({workspaceId:actor.workspaceId,issueId:actor.issueId,createdBy:actor.userId,repositoryPath:code.repositoryPath,agentId:config.agent_id,plannerAgentId:config.planner_agent_id,autoContinue:config.auto_continue,contextDraftId:randomUUID(),planDraftId:randomUUID(),contextSource:this.definitions.context,planningSource:this.definitions.planning,contextHandoff:false,...(config.reproduction_agent_id ? {reproduction:{agentId:config.reproduction_agent_id,draftId:randomUUID(),source:this.definitions.reproduction!,handoff:false}} : {}),
        contextContract:{input:config.input,kind:config.item_kind,decisionMode:config.decision_mode,binding:{workspaceId:actor.workspaceId,issueId:actor.issueId,revision,codeVersion:code.codeVersion,contractVersion:createHash("sha256").update(JSON.stringify(config)).digest("hex")}}});
      const inserted=this.db.prepare("INSERT INTO requirement_contract(workspace_id,issue_id,revision,payload) VALUES(?,?,?,?) ON CONFLICT DO NOTHING").run(record.workspaceId,record.issueId,revision,JSON.stringify(record));
      if(inserted.changes !== 1)throw new DraftConflictError("Requirement revision changed");
      return this.view(record);
    }
    if(!record)throw new Error("Requirement is not configured");
    if(action === "publication")return this.publish(record,request);
    if(action === "publication-ack"){
      if(actor.kind !== "host")throw new Error("Only the host can acknowledge native publication");
      const payload=z.strictObject({issue_id:z.uuid(),contract_hash:text}).parse(request.payload),unit=this.managedUnit(record.workspaceId,payload.issue_id);
      if(!record.publicationRequestedBy || !unit || unit.parentIssueId !== record.issueId || unit.parentRevision !== record.contextContract.binding.revision || unit.contractHash !== payload.contract_hash)throw new DraftConflictError("Native publication does not match the frozen plan");
      unit.published=true;this.db.prepare("UPDATE requirement_unit SET payload=? WHERE workspace_id=? AND issue_id=?").run(JSON.stringify(unit),unit.workspaceId,unit.issueId);return {acknowledged:true};
    }
    if(action === "review-inputs"){if(actor.kind !== "host")throw new Error("Only the host can inspect requirement review inputs");const facts=await this.reviewFacts(record);return {review_units:facts.units};}
    if(action === "configure-review")return this.configureReview(record,request);
    if(action === "review-ack")return this.acknowledgeReview(record,request);
    const role=this.role(record),review=record.reviews.at(-1);
    if(role.chain === "reproduction" && ["selection","prepare-run","bind","start","command","read"].includes(action))await this.validateReproduction(record);
    if(action === "completion" || action === "verified-binding"){
      if(actor.kind !== "host")throw new Error("Only the host can authorize requirement completion");
      const conclusion=await this.reviewCompletion(record);
      if(!conclusion.review.acknowledgement || conclusion.review.acknowledgement.reportHash !== conclusion.review.reportHash)throw new DraftConflictError("Read and acknowledge the current final review report before completing the requirement");
      return {configured:true,allowed:true,binding:conclusion.result.binding,repository_path:record.repositoryPath,review_units:conclusion.review.units};
    }
    if(action === "overview"){if(actor.kind !== "human")throw new Error("A human actor is required");return this.overview(record);}
    if(review && ["selection","prepare-run","bind","start","command","read"].includes(action))await this.validateReview(record,review);
    if(action === "selection")return { ...(review ? {review_units:review.units} : {}),configured:actor.kind === "task" && role.agentId === actor.agentId,chain:role.chain,repository_path:record.repositoryPath,code_version:role.contract.binding.codeVersion};
    if(action === "prepare-run"){
      if(actor.kind !== "human")throw new Error("Only a human can start a requirement run");
      const payload=z.object({expected_revision:sequence,expected_sequence:sequence,execution_resources:z.array(z.object({path:text,mode:z.enum(["in_place","worktree"])})).optional()}).parse(request.payload),draft=await this.drafts.read(role.draftId);
      if(payload.expected_revision !== record.contextContract.binding.revision || payload.expected_sequence !== (draft?.sequence ?? 0))throw new DraftConflictError("Requirement checkpoint changed");
      if(draft?.status === "abandoned" || ["planning","review"].includes(role.chain) && draft?.status === "completed")throw new Error("Planning is finished; delivery publication and final review remain pending");
      if(draft?.runtimeInputs.some(item=>item.active && !item.answer))throw new Error("Answer all pending requirement questions first");
      if(review && payload.execution_resources?.some(item=>item.mode !== record.deliveryPolicy!.mode))throw new Error("Reviewer execution mode differs from its frozen policy");
      if(payload.execution_resources && (payload.execution_resources.length !== 1 || payload.execution_resources.some(item=>repositoryCommonDirectory(item.path) !== repositoryCommonDirectory(record.repositoryPath) || item.mode === "in_place" && repositorySnapshot(item.path,false).repositoryPath !== record.repositoryPath)))throw new Error("Bind exactly one matching project repository");
      return {...(review ? {review_units:review.units} : {}),agent_id:role.agentId,revision:record.contextContract.binding.revision,sequence:draft?.sequence ?? 0};
    }
    if(action === "bind"){
      if(actor.kind !== "daemon" || actor.agentId !== role.agentId)throw new Error("Only the owning runtime can bind this requirement role");
      const payload=z.strictObject({work_dir:text,mode:z.enum(["in_place","worktree"]),overlays:z.array(z.strictObject({path:text,hash:text}))}).parse(request.payload),code=repositorySnapshot(payload.work_dir,false);
      if(review && payload.mode !== record.deliveryPolicy!.mode)throw new Error("Reviewer execution mode differs from its frozen policy");
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
    const engine=new CommandChainEngine(this.drafts,role.chain === "review" ? createReviewHandlers(review!.contract) : role.chain === "reproduction" ? createReproductionHandlers(record.reproduction!.contract!) : role.chain === "context" ? createContextHandlers(record.contextContract) : createPlanningHandlers(record.planningContract!));let draft=await this.drafts.read(role.draftId);
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
    if(review && draft?.status === "completed")await this.settleReview(record,draft);
    const view=this.view(record,draft);
    if(actor.kind === "task" && draft?.status === "completed" && role.chain === "context")await this.settleContext(record,draft);
    if(actor.kind === "task" && draft?.status === "completed" && role.chain === "reproduction")await this.settleReproduction(record,draft);
    return view;
  }
  private view(record:Record,draft?:ChainDraft){
    const role=this.role(record),phase=draft?.phase ? draft.definition.phases[draft.phase] : undefined;
    return {chain:role.chain,agentId:role.agentId,repositoryPath:record.repositoryPath,contract:role.contract,draft:draft ?? null,
      instructions:phase?.type === "builtin" ? `${phase.builtin}: ${role.chain === "reproduction" ? "Reproduce without modifying persistent repository files. Preserve exact Existing Expected; distinguish current observations from reports and root-cause hypotheses. Only reproduced may hand off to planning. Missing facts require not_reproduced and human input. After answers, rewind investigation and obtain fresh observations before changing the verdict." : role.chain === "review" ? "Reconcile original obligations and combined final behavior against frozen independent verification. Do not run tests, invent delivery facts, or treat development claims as proof. Record a closure gap when evidence does not establish composition; forward complete units instead of a report. Human reading acknowledgement is separate." : "Read the frozen inputs."} Requirement acceptances use acceptance.put/remove only in their definition phase. ${decisionPolicies[record.contextContract.decisionMode]}` : phase?.instructions,
      decisionSchema:z.toJSONSchema(decisionProposalSchema),conclusion:draft?.status === "completed" ? role.chain === "reproduction" ? compileReproductionConclusion(draft,record.reproduction!.contract!) : role.chain === "review" ? compileReviewConclusion(draft,record.reviews.at(-1)!.contract) : role.chain === "context" ? compileContextConclusion(draft,record.contextContract) : compilePlanningConclusion(draft,record.planningContract!) : null,receipts:[]};
  }
}
