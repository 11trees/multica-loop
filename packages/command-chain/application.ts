import { RequirementApplication, type RequirementDefinitions } from "./requirement-application";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { z } from "zod";
import { parse } from "yaml";
import { parseCommandChainDefinition, type CommandChainProfile } from "./definition";
import { CommandChainEngine, DraftConflictError, chainCommandSchema, draftSchema, type ChainDraft } from "./runtime";
import { SqliteDraftStore } from "./sqlite-store";
import { compileVerificationConclusion, createVerificationHandlers, verificationContractSchema, createVerificationRecheck } from "./verification";
import { commandReceiptSchema, createDevelopmentHandlers, compileDevelopmentConclusion, type CommandReceipt } from "./development";
import { git, repositorySnapshot as snapshot, repositoryFingerprint, repositoryCommonDirectory, repositoryBranch, captureRepositoryOverlays } from "./repository";
import { artifactBlock } from "./artifacts";
import { decisionProposalSchema, decisionPolicies } from "./decisions";
import { analysisContractSchema, analysisProfile, deliveryUnitSchema, createAnalysisHandlers, createAnalysisRework, compileAnalysisConclusion } from "./analysis";

const text = z.string().trim().min(1);
const sequence = z.number().int().nonnegative();
const scope = { workspaceId: z.uuid(), issueId: z.uuid() };
const human = z.strictObject({ kind: z.literal("human"), userId: z.uuid(), ...scope });
const task = z.strictObject({ kind: z.literal("task"), agentId: z.uuid(), attemptId: text, ...scope });
const daemon = task.extend({ kind: z.literal("daemon") });
const host = z.strictObject({ kind: z.literal("host"), ...scope });
const coordinator = z.strictObject({ kind: z.literal("coordinator") });
const actor = z.discriminatedUnion("kind", [human, task, daemon, host, coordinator]);
export const applicationRequestSchema = z.strictObject({
  actor,
  action: z.enum(["configure", "read", "start", "command", "answer", "abandon", "selection", "receipt", "completion", "bind", "overview", "prepare-run", "continuations", "verified-binding", "publication", "publication-ack", "delivery-policy", "activate-unit", "accept-unit", "parent-scope", "review-inputs", "configure-review", "review-ack", "begin-feedback", "cancel-feedback", "feedback-restored", "authorize-feedback-work", "prepare-feedback-verification", "prepare-feedback-report"]),
  payload: z.unknown().optional(),
});
export type ApplicationRequest = z.infer<typeof applicationRequestSchema>;
const configuration = z.strictObject({
  expected_revision: sequence,
  agent_id: z.uuid(), repository_path: text,
  developer_agent_id: z.uuid().optional(),
  analyst_agent_id: z.uuid().optional(), unit: deliveryUnitSchema.optional(),
  decision_mode: analysisContractSchema.shape.decisionMode.optional(),
  dependency_issues: z.array(z.strictObject({key:text,issue_id:z.uuid()})).optional().default([]),
  implementation_guidance: text.optional(),
  auto_continue: z.boolean().optional().default(false),
  max_reworks: z.number().int().min(0).max(10).optional().default(0),
  sources: verificationContractSchema.shape.sources,
});
const executionSchema = z.strictObject({
  repositoryPath: text, mode: z.enum(["in_place", "worktree"]), branchRef: z.string(),
  agentId: z.uuid(), attemptId: text,
  overlays: z.array(z.strictObject({ path: text, hash: text, executable: z.boolean(), originalHash: text.nullable(), originalExecutable: z.boolean() })),
});
type Execution = z.infer<typeof executionSchema>;
const recordSchema = z.strictObject({
  ...scope, agentId: z.uuid(), repositoryPath: text, draftId: z.uuid(),
  createdBy: z.uuid(), definitionSource: text, autoContinue: z.boolean().optional().default(false),
  rootRevision: z.number().int().positive().optional(), reworkRound: sequence.optional().default(0), reworkLimit: sequence.max(10).optional().default(0),
  reworkFrom: z.strictObject({ revision: z.number().int().positive(), draftId: z.uuid(), kind: z.enum(["implementation","specification"]).optional().default("implementation") }).optional(),
  failure: z.strictObject({ signature: text, codeTree: text, decision: z.enum(["rework", "reanalysis", "analysis", "stagnant", "budget", "manual"]) }).optional(),
  managedBy:z.strictObject({parentIssueId:z.uuid(),parentRevision:z.number().int().positive(),contractHash:text,mode:z.enum(["in_place","worktree"])}).optional(),
  contract: verificationContractSchema,
  development: z.strictObject({ agentId: z.uuid(), draftId: z.uuid(), definitionSource: text, baseCodeVersion: text, implementationGuidance: text.optional(), handoff: z.boolean(), conclusion: z.json().optional() }).optional(),
  analysis: z.strictObject({agentId:z.uuid(),draftId:z.uuid(),definitionSource:text,contract:analysisContractSchema,handoff:z.boolean(),conclusion:z.json().optional()}).optional(),
  delivery: executionSchema.optional(), verificationExecution: executionSchema.optional(),
});
type Record = z.infer<typeof recordSchema>;
const profile: CommandChainProfile = {
  id: "verification", agent: "test-agent",
  requiredBuiltins: ["verification-inputs", "verification-plan", "verification-execution", "verification-finalize"],
  builtins: {
    "verification-inputs": { acceptsArtifacts: false }, "verification-plan": { acceptsArtifacts: true },
    "verification-execution": { acceptsArtifacts: true }, "verification-finalize": { acceptsArtifacts: false },
  }, metadataKeys: [], repositoryAdapters: [],
};
const instructions: { [key: string]: string } = {
  "delivery-spec": "Read the frozen delivery sources, acceptance oracles, guardrails, and recovery obligations. Do not edit the business contract.",
  "implementation-evidence": "Implement the frozen acceptance scope. Register acceptance.assess claims with concrete evidence and resolve recovery sources. Request runtime input if blocked.",
  "command-verification": "Run real checks through the runtime. Inspect captured receipts, select current successful records with check.record, and disclose residual risks. Do not supply exit codes yourself.",
  "verification-inputs": "Read the frozen sources and their oracles. Do not replace them with development claims.",
  "verification-plan": "Plan scenarios against every frozen source before recording actual results. Cover at least one acceptance through frontend. Request runtime input if blocked.",
  "verification-execution": "Execute the frozen scenarios. Record independent observations under matching scenario keys. Existing scenarios are immutable; new risks use new keys. Request runtime input and suspend when blocked.",
  "verification-finalize": "Recheck the frozen inputs, observations, and evidence review. A failed implementation can still produce a completed verification report.",
};

const developmentProfile: CommandChainProfile = {
  id: "development", agent: "dev-agent", requiredBuiltins: ["delivery-spec", "implementation-evidence", "command-verification"],
  builtins: { "delivery-spec": { acceptsArtifacts: false }, "implementation-evidence": { acceptsArtifacts: true }, "command-verification": { acceptsArtifacts: true } },
  metadataKeys: ["tracking.requirement_card_id"], repositoryAdapters: [],
};

/** Invoked only over the authenticated Go host's private stdin/stdout boundary. */
export class EngineeringApplication {
  private readonly db: DatabaseSync;
  private readonly drafts: SqliteDraftStore;
  private readonly requirements:RequirementApplication;

  constructor(database: string, private readonly definitionSource: string, private readonly developmentSource?: string, private readonly analysisSource?: string,requirementDefinitions?:RequirementDefinitions) {
    parseCommandChainDefinition(definitionSource, profile);
    this.db = new DatabaseSync(database);
    this.db.exec(`CREATE TABLE IF NOT EXISTS engineering_contract (
      workspace_id TEXT NOT NULL, issue_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (workspace_id, issue_id, revision)
    )`);
    this.drafts = new SqliteDraftStore(database);
    this.db.exec("CREATE TABLE IF NOT EXISTS engineering_receipt (draft_id TEXT NOT NULL, receipt_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (draft_id, receipt_id))");
    this.requirements=new RequirementApplication(this.db,this.drafts,requirementDefinitions,async(workspaceId,issueId)=>{
      const record=this.current(workspaceId,issueId),verified=await this.verifiedBinding(record);
      if(!record?.analysis?.handoff)throw new Error("Requirement review needs a resolved delivery specification");
      return {binding:verified.binding,analysis:compileAnalysisConclusion(this.storedDraft(record.analysis.draftId),record.analysis.contract),verification:compileVerificationConclusion(this.storedDraft(record.draftId),record.contract)};
    });
    this.db.exec("CREATE TABLE IF NOT EXISTS engineering_execution (workspace_id TEXT NOT NULL, issue_id TEXT NOT NULL, revision INTEGER NOT NULL, agent_id TEXT NOT NULL, attempt_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (workspace_id, issue_id, revision, agent_id, attempt_id))");
  }

  private current(workspaceId: string, issueId: string): Record | undefined {
    const row = this.db.prepare("SELECT payload FROM engineering_contract WHERE workspace_id = ? AND issue_id = ? ORDER BY revision DESC LIMIT 1").get(workspaceId, issueId);
    return row ? recordSchema.parse(JSON.parse(String(row.payload))) : undefined;
  }

  private activeRole(record: Record) {
    if(record.analysis && !record.analysis.handoff)return {chain:"analysis",agentId:record.analysis.agentId,draftId:record.analysis.draftId,definitionSource:record.analysis.definitionSource};
    if(record.development && !record.development.handoff)return {chain:"development",agentId:record.development.agentId,draftId:record.development.draftId,definitionSource:record.development.definitionSource};
    return {chain:"verification",agentId:record.agentId,draftId:record.draftId,definitionSource:record.definitionSource};
  }

  private async dependencyBinding(workspaceId:string,issueId:string) {
    const result=await this.invoke({actor:{kind:"host",workspaceId,issueId},action:"verified-binding"});
    if(!("allowed" in result) || !result.allowed || !result.configured || !("binding" in result))throw new Error("Analysis dependencies require registered current passed verification");
    if(!("repository_path" in result))throw new Error("Verified dependency repository is unavailable");
    return {binding:verificationContractSchema.shape.binding.parse(result.binding),repositoryPath:text.parse(result.repository_path)};
  }

  private async validateDependencies(record:Record) {
    for(const dependency of record.analysis?.contract.dependencies ?? []){
      const binding=await this.dependencyBinding(record.workspaceId,dependency.issueId);
      if(JSON.stringify(binding.binding) !== JSON.stringify(dependency.binding))throw new DraftConflictError(`Dependency ${dependency.key} changed after analysis was frozen`);
      if(repositoryCommonDirectory(record.repositoryPath) === repositoryCommonDirectory(dependency.repositoryPath)){
        try {git(record.repositoryPath,["merge-base","--is-ancestor",dependency.binding.codeVersion,record.analysis!.contract.binding.codeVersion]);}catch{throw new DraftConflictError(`Dependency ${dependency.key} is not incorporated into the analysis base`);}
      }
    }
  }

  private async settleAnalysis(record:Record,draft:ChainDraft) {
    if(!record.analysis || record.analysis.handoff)return;
    await this.validateDependencies(record);
    const conclusion=compileAnalysisConclusion(draft,record.analysis.contract);
    const sources=[...record.analysis.contract.sources,
      ...conclusion.handoff.guardrails.map(item=>({key:`analysis-g-${createHash("sha256").update(`${draft.id}:${item.key}`).digest("hex").slice(0,16)}`,kind:"guardrail" as const,description:item.value.content!,oracle:item.value.content!,sourceRef:`DELIVERY-SPEC:${draft.id}:guardrail:${item.key}`})),
      ...conclusion.handoff.verificationFocus.map(item=>({key:`analysis-f-${createHash("sha256").update(`${draft.id}:${item.key}`).digest("hex").slice(0,16)}`,kind:"focus" as const,description:item.value.expected!,oracle:item.value.oracle!,sourceRef:`DELIVERY-SPEC:${draft.id}:focus:${item.key}`}))];
    record.contract=verificationContractSchema.parse({...record.contract,sources,binding:{...record.contract.binding,contractVersion:createHash("sha256").update(JSON.stringify(conclusion)).digest("hex")}});
    if(record.development)record.development.implementationGuidance=conclusion.handoff.implementationGuidance;
    record.analysis.conclusion=JSON.parse(JSON.stringify(conclusion));record.analysis.handoff=true;this.save(record);
  }

  private async invokeAnalysis(record:Record,actor:z.infer<typeof human>|z.infer<typeof task>,action:string,payload:unknown) {
    const analysis=record.analysis!;await this.validateDependencies(record);
    const execution=actor.kind === "task" ? this.execution(record,actor) : undefined;
    if(execution){const code=snapshot(execution.repositoryPath,true,execution.overlays);if(code.codeVersion !== analysis.contract.binding.codeVersion)throw new DraftConflictError("Analysis repository changed from the frozen snapshot");}
    const engine=new CommandChainEngine(this.drafts,createAnalysisHandlers(analysis.contract));let draft=await this.drafts.read(analysis.draftId);
    if(action === "start" && actor.kind === "task"){
      if(!draft && record.reworkFrom?.kind === "specification"){
        const previous=this.revision(record.workspaceId,record.issueId,record.reworkFrom.revision);
        if(!previous?.analysis)throw new Error("Reanalysis history is unavailable");
        draft=createAnalysisRework(this.storedDraft(previous.analysis.draftId),previous.analysis.contract,analysis.contract,analysis.draftId,actor.attemptId);
        await this.drafts.create(draft);
      }else if(!draft)draft=await engine.create({id:analysis.draftId,chain:parseCommandChainDefinition(analysis.definitionSource,analysisProfile),binding:analysis.contract.binding,attemptId:actor.attemptId});
      else if(draft.status === "abandoned")throw new Error("Analysis was abandoned; freeze a new revision");
      else if(draft.status !== "completed" && draft.attemptId !== actor.attemptId)draft=await engine.resume(draft.id,draft.sequence,actor.attemptId);
    }else if(action !== "read"){
      if(!draft)throw new Error("Start the analysis draft before editing");
      if(action === "command" && actor.kind === "task"){
        const command=z.strictObject({expected_sequence:sequence,command:chainCommandSchema}).parse(payload);draft=await engine.execute(draft.id,{attemptId:actor.attemptId,expectedSequence:command.expected_sequence},command.command);
      }else if(action === "answer" && actor.kind === "human"){
        const answer=z.strictObject({expected_sequence:sequence,request_id:text,answer:z.string().max(20000),selected_option:text.optional()}).parse(payload);
        draft=await engine.answerRuntimeInput(draft.id,{expectedSequence:answer.expected_sequence,requestId:answer.request_id,answer:answer.answer,selectedOption:answer.selected_option,userId:actor.userId});
      }else if(action === "abandon" && actor.kind === "human"){
        const abandon=z.strictObject({expected_sequence:sequence,reason:text}).parse(payload);draft=await engine.abandon(draft.id,abandon.expected_sequence,abandon.reason,actor.userId);
      }else throw new Error("This analysis operation requires its authenticated role");
    }
    const conclusion=draft?.status === "completed" ? compileAnalysisConclusion(draft,analysis.contract) : null;
    if(actor.kind === "task" && draft?.status === "completed")await this.settleAnalysis(record,draft);
    const phase=draft?.phase ? draft.definition.phases[draft.phase] : undefined;
    return {chain:"analysis",agentId:analysis.agentId,repositoryPath:execution?.repositoryPath ?? record.repositoryPath,contract:analysis.contract,draft:draft ?? null,
      instructions:phase?.type === "builtin" ? `${phase.builtin}: Read the frozen delivery unit and sources. Use decision.propose in proposal; decision.ask/resolve/reopen in resolution. Never impersonate a human selection. ${decisionPolicies[analysis.contract.decisionMode]}` : phase?.instructions,
      decisionSchema:z.toJSONSchema(decisionProposalSchema),decisionCommands:[{type:"decision.propose",decision:"See decisionSchema"},{type:"decision.ask",key:"<decision key>"},{type:"decision.resolve",key:"<decision key>",option:"<option id>",authority:"user | upstream | project_evidence | agent_authority",decision:"<decision text>",rationale:"<why>",evidence:"<source>"},{type:"decision.reopen",key:"<decision key>"}],
      conclusion,receipts:[],rework:this.reworkView(record),recovery:record.reworkFrom?.kind === "specification" ? this.analysisRecovery(record) : null};
  }

  private analysisRecovery(record:Record) {
    const previous=this.revision(record.workspaceId,record.issueId,record.reworkFrom!.revision);
    if(!previous?.analysis)throw new Error("Reanalysis history is unavailable");
    const draft=this.storedDraft(record.reworkFrom!.draftId);
    return {previousSpec:previous.analysis.conclusion,verification:compileVerificationConclusion(draft,previous.contract),artifacts:draft.artifacts.filter(item=>item.ref !== "verification.sources")};
  }

  private revision(workspaceId: string, issueId: string, revision: number): Record | undefined {
    const row = this.db.prepare("SELECT payload FROM engineering_contract WHERE workspace_id = ? AND issue_id = ? AND revision = ?").get(workspaceId, issueId, revision);
    return row ? recordSchema.parse(JSON.parse(String(row.payload))) : undefined;
  }

  private failureHistory(record: Record) {
    const root = record.rootRevision ?? record.contract.binding.revision;
    return this.db.prepare("SELECT payload FROM engineering_contract WHERE workspace_id = ? AND issue_id = ? AND revision <= ? ORDER BY revision")
      .all(record.workspaceId, record.issueId, record.contract.binding.revision).map(row => recordSchema.parse(JSON.parse(String(row.payload))))
      .filter(item => (item.rootRevision ?? item.contract.binding.revision) === root && item.failure);
  }

  private storedDraft(id: string): ChainDraft {
    const row = this.db.prepare("SELECT payload FROM chain_drafts WHERE id = ?").get(id);
    if (!row) throw new Error("Engineering failure history is unavailable");
    return draftSchema.parse(JSON.parse(String(row.payload)));
  }

  private reworkView(record: Record) {
    return {
      root_revision: record.rootRevision ?? record.contract.binding.revision, round: record.reworkRound, limit: record.reworkLimit,
      stop_reason: record.failure && !["rework","reanalysis"].includes(record.failure.decision) ? record.failure.decision : null,
      history: this.failureHistory(record).map(item => {
        const draft = this.storedDraft(item.draftId);
        return { revision: item.contract.binding.revision, draft_id: draft.id, code_version: item.contract.binding.codeVersion, decision: item.failure!.decision, conclusion: compileVerificationConclusion(draft, item.contract),
          artifacts: draft.artifacts.filter(artifact => artifact.ref !== "verification.sources").map(({ ref, key, content }) => ({ ref, key, content })) };
      }),
    };
  }

  private recoverySources(record: Record) {
    if (!record.reworkFrom || record.reworkFrom.kind === "specification") return [];
    const previous = this.revision(record.workspaceId, record.issueId, record.reworkFrom.revision);
    if (!previous) throw new Error("Rework contract history is unavailable");
    const draft = this.storedDraft(record.reworkFrom.draftId);
    return compileVerificationConclusion(draft, previous.contract).results.filter(result => result.status === "failed").map(result => {
      const scenario = z.object({ title: text, expected: text }).parse(parse(draft.artifacts.find(item => item.ref === "verification.scenarios" && item.key === result.key)!.content));
      return { key: `rework-${createHash("sha256").update(`${draft.id}:${result.key}`).digest("hex").slice(0, 20)}`, kind: "recovery" as const,
        description: `Repair failed scenario ${scenario.title}. Observed: ${result.actualBehavior ?? result.evidence}`, oracle: scenario.expected,
        sourceRef: `VERIFICATION:${draft.id}:${result.key}` };
    });
  }

  private settleFailure(record: Record, draft: ChainDraft) {
    if (record.failure) return;
    const conclusion = compileVerificationConclusion(draft, record.contract);
    if (conclusion.verdict !== "failed") return;
    const codeTree = git(record.repositoryPath, ["rev-parse", `${record.contract.binding.codeVersion}^{tree}`]);
    const normalized = (value: string) => value.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>").replace(/\b(?:0x)?[0-9a-f]{12,}\b/gi, "<id>").replace(/\s+/g, " ").trim();
    const signature = createHash("sha256").update(JSON.stringify({ sources: record.contract.sources.map(source=>({kind:source.kind,description:source.description,oracle:source.oracle,key:normalized(source.key),sourceRef:normalized(source.sourceRef)})), failures: conclusion.results.filter(result => result.status === "failed")
      .map(result => ({ key: result.key, kind: result.failureKind, actual: normalized(result.actualBehavior ?? "") })).sort((a, b) => a.key.localeCompare(b.key)) })).digest("hex");
    const previous = this.failureHistory(record).at(-1)?.failure;
    const specification=conclusion.failureKind === "specification";
    const authorized=record.autoContinue && record.development && record.reworkLimit && (!specification || record.analysis);
    const decision = !authorized ? specification ? "analysis" : "manual" :
      previous?.signature === signature && previous.codeTree === codeTree ? "stagnant" : record.reworkRound >= record.reworkLimit ? "budget" : specification ? "reanalysis" : "rework";
    record.failure = { signature, codeTree, decision };
    const revision = record.contract.binding.revision + 1;
    const binding={...record.contract.binding,revision};
    const sources=decision === "reanalysis" ? record.analysis!.contract.sources : record.contract.sources;
    binding.contractVersion=createHash("sha256").update(JSON.stringify({workspaceId:record.workspaceId,issueId:record.issueId,revision,sources})).digest("hex");
    const next = ["rework","reanalysis"].includes(decision) ? recordSchema.parse({ ...record, failure: undefined, delivery: undefined, verificationExecution: undefined,
      rootRevision: record.rootRevision ?? record.contract.binding.revision, reworkRound: record.reworkRound + 1,
      reworkFrom: { revision: record.contract.binding.revision, draftId: draft.id,kind:specification ? "specification" : "implementation" }, draftId: randomUUID(),
      contract: { binding,sources },
      ...(decision === "reanalysis" ? {analysis:{...record.analysis!,draftId:randomUUID(),handoff:false,conclusion:undefined,contract:{...record.analysis!.contract,binding}}} : {}),
      development: { ...record.development!, draftId: randomUUID(), baseCodeVersion: record.contract.binding.codeVersion, handoff: false, conclusion: undefined,
        ...(decision === "reanalysis" ? {implementationGuidance:undefined} : {}) },
    }) : undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.current(record.workspaceId, record.issueId)!.contract.binding.revision !== record.contract.binding.revision) throw new DraftConflictError("Engineering revision changed while settling verification");
      this.save(record);
      if (next) this.db.prepare("INSERT INTO engineering_contract (workspace_id, issue_id, revision, payload) VALUES (?, ?, ?, ?)").run(next.workspaceId, next.issueId, revision, JSON.stringify(next));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private devContract(record: Record) {
    const guidance=record.development!.implementationGuidance;
    if(!guidance)throw new Error("Development has no frozen implementation guidance; complete analysis first");
    return { ...record.contract, sources: [...record.contract.sources, ...this.recoverySources(record)], implementationGuidance: guidance, binding: { ...record.contract.binding, codeVersion: record.development!.baseCodeVersion } };
  }

  private execution(record: Record, actor: z.infer<typeof task> | z.infer<typeof daemon>): Execution {
    const row = this.db.prepare("SELECT payload FROM engineering_execution WHERE workspace_id = ? AND issue_id = ? AND revision = ? AND agent_id = ? AND attempt_id = ?")
      .get(record.workspaceId, record.issueId, record.contract.binding.revision, actor.agentId, actor.attemptId);
    if (!row) throw new Error("The runtime must bind its actual repository before engineering commands");
    return executionSchema.parse(JSON.parse(String(row.payload)));
  }

  private selectionCommit(record: Record) {
    if (!record.development || record.development.handoff) return record.contract.binding.codeVersion;
    const row = this.db.prepare("SELECT payload FROM engineering_execution WHERE workspace_id = ? AND issue_id = ? AND revision = ? AND agent_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(record.workspaceId, record.issueId, record.contract.binding.revision, record.development.agentId);
    const previous = row ? executionSchema.parse(JSON.parse(String(row.payload))) : undefined;
    const commit = previous?.mode === "worktree" && previous.branchRef ? git(record.repositoryPath, ["rev-parse", "--verify", previous.branchRef]) : record.development.baseCodeVersion;
    git(record.repositoryPath, ["merge-base", "--is-ancestor", record.development.baseCodeVersion, commit]);
    return commit;
  }

  private save(record: Record) {
    this.db.prepare("UPDATE engineering_contract SET payload = ? WHERE workspace_id = ? AND issue_id = ? AND revision = ?")
      .run(JSON.stringify(record), record.workspaceId, record.issueId, record.contract.binding.revision);
  }

  private runtime(record: Record, execution?: Execution) {
    return {
      receipts: (): CommandReceipt[] => this.db.prepare("SELECT payload FROM engineering_receipt WHERE draft_id = ?").all(record.development!.draftId).map(row => commandReceiptSchema.parse(JSON.parse(String(row.payload)))),
      fingerprint: () => repositoryFingerprint(execution?.repositoryPath ?? record.repositoryPath, execution?.overlays),
    };
  }

  private engine(record: Record, development = false, execution?: Execution) {
    return new CommandChainEngine(this.drafts, development ? createDevelopmentHandlers(this.devContract(record), this.runtime(record, execution)) : createVerificationHandlers(record.contract));
  }

  private view(record: Record, draft: ChainDraft | undefined, development = false, execution?: Execution) {
    const phase = draft?.phase ? draft.definition.phases[draft.phase] : undefined;
    return {
      chain: development ? "development" : "verification",
      agentId: development ? record.development!.agentId : record.agentId, repositoryPath: execution?.repositoryPath ?? record.repositoryPath, contract: development ? this.devContract(record) : record.contract,
      draft: draft ?? null,
      instructions: phase?.type === "builtin" ? instructions[phase.builtin] : phase?.instructions,
      receipts: development ? this.runtime(record).receipts() : [], rework: this.reworkView(record),
      conclusion: draft?.status === "completed" ? development ? record.development!.conclusion ?? null : compileVerificationConclusion(draft, record.contract) : null,
    };
  }

  private async overview(record: Record | undefined) {
    if (!record) return { enabled: true, configured: false };
    const role=this.activeRole(record),development=role.chain === "development",analysis=role.chain === "analysis";
    const draft=await this.drafts.read(role.draftId);
    const definition=draft?.definition ?? parseCommandChainDefinition(role.definitionSource,analysis ? analysisProfile : development ? developmentProfile : profile).definition;
    const conclusion=draft?.status === "completed" ? analysis ? compileAnalysisConclusion(draft,record.analysis!.contract) : development ? record.development?.conclusion : compileVerificationConclusion(draft,record.contract) : undefined;
    return {
      enabled: true, configured: true, ...(record.managedBy ? {managed_unit:this.requirements.managedUnit(record.workspaceId,record.issueId)} : {}),auto_continue: record.autoContinue, chain: role.chain,
      agent_id: role.agentId,
      revision: record.contract.binding.revision, code_version: record.contract.binding.codeVersion,
      repository_path: record.repositoryPath, draft_id: draft?.id ?? null, sequence: draft?.sequence ?? 0,
      status: draft?.status ?? "unstarted", current_phase: draft?.phase ?? null,
      phases: Object.entries(definition.phases).map(([id]) => ({ id, status: draft?.completedPhases.includes(id) ? "completed" : draft?.phase === id ? "current" : "upcoming" })),
      sources: record.contract.sources.map(({ sourceRef, ...source }) => ({ ...source, source_ref: sourceRef })),
      questions: (draft?.runtimeInputs ?? []).map(input => ({ id: input.id, title: input.title, question: input.question, why: input.why, recommendation: input.recommendation, active: input.active, phase: input.phase, decision_key:input.decisionKey, options:input.options ?? [], recommendation_option:input.recommendationOption,
        answer: input.answer ? { text: input.answer.text, user_id: input.answer.userId, sequence: input.answer.sequence, selected_option:input.answer.selectedOption } : null })),
      artifacts: (draft?.artifacts ?? []).map(item => ({ ref: item.ref, key: item.key, title: artifactBlock(definition, item.ref).title, content: item.content })),
      decisions:draft?.decisions ?? (record.analysis?.handoff ? this.storedDraft(record.analysis.draftId).decisions ?? [] : []), analysis:record.analysis ? {unit:record.analysis.contract.unit,decision_mode:record.analysis.contract.decisionMode,handoff:record.analysis.handoff,spec:record.analysis.conclusion ?? null} : null,
      result: conclusion ?? null, rework: this.reworkView(record),
    };
  }

  private async continuations() {
    const rows = this.db.prepare(`SELECT c.payload FROM engineering_contract c
      WHERE c.revision = (SELECT MAX(latest.revision) FROM engineering_contract latest WHERE latest.workspace_id = c.workspace_id AND latest.issue_id = c.issue_id)`).all();
    const pending = [];
    for (const row of rows) {
      let record = recordSchema.parse(JSON.parse(String(row.payload)));
      if (!record.autoContinue) continue;
      if(record.analysis && !record.analysis.handoff){const draft=await this.drafts.read(record.analysis.draftId);if(draft?.status === "completed")await this.settleAnalysis(record,draft);}
      if (record.reworkLimit > 0 && (record.development?.handoff || !record.development)) {
        const completed = await this.drafts.read(record.draftId);
        if (completed?.status === "completed" && !record.failure) {
          this.settleFailure(record, completed);
          record = this.current(record.workspaceId, record.issueId)!;
        }
      }
      const role=this.activeRole(record),development=role.chain === "development";
      const draftId=role.draftId;
      const draft = await this.drafts.read(draftId);
      const reason = !draft && role.chain === "analysis" && record.managedBy && !record.reworkFrom ? "unit_ready" : !draft && role.chain === "analysis" && record.reworkFrom?.kind === "specification" ? "verification_reanalysis" : !draft && development && record.reworkRound > 0 ? "verification_rework" : !draft && role.chain !== "analysis" && record.analysis?.handoff && !record.development?.handoff ? "analysis_handoff" : !draft && record.development?.handoff ? "development_handoff" :
        draft?.status === "waiting_for_answers" && draft.runtimeInputs.some(input => input.active) && draft.runtimeInputs.every(input => !input.active || input.answer !== null) ? "human_answers" : null;
      if (!reason) continue;
      const sequence = draft?.sequence ?? 0;
      const hash = createHash("sha256").update(`multica:engineering:continuation:${draftId}:${sequence}`).digest("hex");
      const taskId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      pending.push({ ...(record.managedBy ? {parent_issue_id:record.managedBy.parentIssueId} : {}),workspace_id: record.workspaceId, issue_id: record.issueId, agent_id: role.agentId,
        user_id: record.createdBy, task_id: taskId, expected_revision: record.contract.binding.revision, expected_sequence: sequence, reason });
    }
    return pending;
  }

  private async configureDelivery(actor:z.infer<typeof human>,payload:unknown,managed?:{base:string;mode:"in_place"|"worktree";binding:NonNullable<Record["managedBy"]>}) {
    let record=this.current(actor.workspaceId,actor.issueId);
    if (actor.kind !== "human") throw new Error("Only a human can freeze verification contracts");
    const config = configuration.parse(payload);
    if(config.analyst_agent_id && (!config.unit || !this.analysisSource))throw new Error("Analysis requires a frozen delivery unit and its definition");
    if(config.analyst_agent_id && [config.agent_id,config.developer_agent_id].includes(config.analyst_agent_id))throw new Error("Analysis, development, and verification require separate agents");
    if(!config.analyst_agent_id && (config.unit || config.dependency_issues.length))throw new Error("Analysis inputs require an analyst agent");
    if (config.max_reworks > 0 && (!config.auto_continue || !config.developer_agent_id)) throw new Error("Automatic rework requires automatic continuation and a development agent");
    if (config.developer_agent_id === config.agent_id) throw new Error("Development and independent verification require different agents");
    if (config.developer_agent_id && !config.analyst_agent_id && !config.implementation_guidance) throw new Error("Development requires frozen implementation guidance");
    if (config.developer_agent_id && !this.developmentSource) throw new Error("Development definition is unavailable");
    if (config.expected_revision !== (record?.contract.binding.revision ?? 0)) throw new DraftConflictError("Contract revision changed; reload before configuring");
    const previousDraft = record && await this.drafts.read(this.activeRole(record).draftId);
    if (previousDraft && previousDraft.status !== "completed" && previousDraft.status !== "abandoned") throw new Error("Abandon the active draft before replacing its contract");
    const code = snapshot(config.repository_path,managed?.mode !== "worktree");
    if(managed){git(code.repositoryPath,["cat-file","-e",`${managed.base}^{commit}`]);code.codeVersion=managed.base;}
    const revision = config.expected_revision + 1;
    const sources = config.sources;
    const contractVersion = createHash("sha256").update(JSON.stringify({ workspaceId: actor.workspaceId, issueId: actor.issueId, revision, sources })).digest("hex");
    const contract = verificationContractSchema.parse({
      binding: { workspaceId: actor.workspaceId, issueId: actor.issueId, revision, contractVersion, codeVersion: code.codeVersion }, sources,
    });
    const dependencies=[];
    if(config.analyst_agent_id){
      if(new Set(config.unit!.dependsOn).size !== config.unit!.dependsOn.length || new Set(config.dependency_issues.map(item=>item.key)).size !== config.dependency_issues.length)throw new Error("Dependency keys must be unique");
      for(const key of config.unit!.dependsOn){const dependency=config.dependency_issues.find(item=>item.key === key);if(!dependency || dependency.issue_id === actor.issueId)throw new Error("Delivery dependency mapping is missing or self-referential");const verified=await this.dependencyBinding(actor.workspaceId,dependency.issue_id);
        if(repositoryCommonDirectory(code.repositoryPath) === repositoryCommonDirectory(verified.repositoryPath)){
          try{git(code.repositoryPath,["merge-base","--is-ancestor",verified.binding.codeVersion,code.codeVersion]);}catch{throw new DraftConflictError(`Dependency ${key} is not incorporated into the analysis base`);}
        }
        dependencies.push({key,issueId:dependency.issue_id,binding:verified.binding,repositoryPath:verified.repositoryPath});}
    }
    record = recordSchema.parse({ ...(managed ? {managedBy:managed.binding} : {}), workspaceId: actor.workspaceId, issueId: actor.issueId, agentId: config.agent_id,
      repositoryPath: code.repositoryPath, draftId: randomUUID(), createdBy: actor.userId, autoContinue: config.auto_continue, rootRevision: revision, reworkLimit: config.max_reworks,
      definitionSource: this.definitionSource, contract,
      ...(config.analyst_agent_id ? {analysis:{agentId:config.analyst_agent_id,draftId:randomUUID(),definitionSource:this.analysisSource,contract:{...contract,unit:config.unit,decisionMode:config.decision_mode ?? "balanced",dependencies},handoff:false}} : {}),
      ...(config.developer_agent_id ? { development: { agentId: config.developer_agent_id, draftId: randomUUID(), definitionSource: this.developmentSource, baseCodeVersion: code.codeVersion, implementationGuidance: config.implementation_guidance, handoff: false } } : {}),
    });
    const inserted = this.db.prepare("INSERT INTO engineering_contract (workspace_id, issue_id, revision, payload) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .run(actor.workspaceId, actor.issueId, revision, JSON.stringify(record));
    if (inserted.changes !== 1) throw new DraftConflictError("Contract revision changed");
    return record.analysis ? this.invokeAnalysis(record,actor,"read",undefined) : this.view(record, undefined, Boolean(record.development));
  }
  private async verifiedBinding(record:Record|undefined){
      if(!record || record.analysis && !record.analysis.handoff || record.development && !record.development.handoff)throw new Error("Analysis dependencies require registered current passed verification");
      await this.validateDependencies(record);
      const draft=await this.drafts.read(record.draftId);
      if(!draft || draft.status !== "completed" || !record.verificationExecution)throw new Error("Analysis dependencies require registered current passed verification");
      const conclusion=compileVerificationConclusion(draft,record.contract);
      if(conclusion.verdict !== "passed")throw new Error("Analysis dependencies require registered current passed verification");
      git(record.repositoryPath,["cat-file","-e",`${conclusion.binding.codeVersion}^{commit}`]);
      return {configured:true,allowed:true,binding:conclusion.binding,repository_path:record.repositoryPath};
  }

  private async managedProgress() {
    const pending=[];
    for(const {parent,units} of this.requirements.executionPlans()){
      const unit=units.find(unit=>!parent.accepted[unit.unit.key]);if(!unit?.published)continue;
      const current=this.current(unit.workspaceId,unit.issueId),draft=current ? await this.drafts.read(this.activeRole(current).draftId) : undefined;
      const verdict=current && this.activeRole(current).chain === "verification" && draft?.status === "completed" ? compileVerificationConclusion(draft,current.contract).verdict : null;
      if(current && verdict !== "passed")continue;
      const hash=createHash("sha256").update(`multica:managed:${unit.issueId}:${unit.contractHash}`).digest("hex"),taskId=`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
      pending.push({workspace_id:unit.workspaceId,issue_id:unit.issueId,parent_issue_id:parent.issueId,agent_id:current ? parent.deliveryPolicy!.verifierId : parent.deliveryPolicy!.analystId,user_id:parent.deliveryPolicy!.userId,expected_revision:unit.parentRevision,expected_sequence:unit.planSequence,task_id:taskId,reason:current ? "unit_passed" : "unit_activation",unit_issue_ids:units.map(item=>item.issueId)});
    }return pending;
  }
  private async activateManaged(request:ApplicationRequest){
    const actor=request.actor;if(actor.kind !== "host")throw new Error("Only the host can activate a planned unit");
    const payload=z.strictObject({expected_revision:sequence,expected_sequence:sequence,execution_mode:z.enum(["in_place","worktree"])}).parse(request.payload);
    const context=this.requirements.executionContext(actor.workspaceId,actor.issueId);if(!context)throw new Error("Managed unit is unavailable");
    const {unit,parent,policy,units,index}=context;
    if(payload.expected_revision !== unit.parentRevision || payload.expected_sequence !== unit.planSequence || payload.execution_mode !== policy.mode)throw new DraftConflictError("Managed activation does not match its frozen plan and mode");
    let record=this.current(actor.workspaceId,actor.issueId);
    if(!record){
      const previous=index>0 ? parent.accepted[units[index-1]!.unit.key]! : parent.contextContract.binding;
      for(const prior of units.slice(0,index)){const binding=await this.dependencyBinding(unit.workspaceId,prior.issueId);if(JSON.stringify(binding.binding) !== JSON.stringify(parent.accepted[prior.unit.key]))throw new DraftConflictError("A preceding verified delivery changed");}
      if(policy.mode === "in_place" && snapshot(parent.repositoryPath).codeVersion !== previous.codeVersion)throw new DraftConflictError("In-place repository must match the preceding verified delivery");
      git(parent.repositoryPath,["merge-base","--is-ancestor",parent.contextContract.binding.codeVersion,previous.codeVersion]);
      await this.configureDelivery({kind:"human",workspaceId:unit.workspaceId,issueId:unit.issueId,userId:policy.userId},{expected_revision:0,repository_path:parent.repositoryPath,agent_id:policy.verifierId,developer_agent_id:policy.developerId,analyst_agent_id:policy.analystId,unit:unit.unit,sources:unit.sources,decision_mode:parent.contextContract.decisionMode,auto_continue:true,max_reworks:policy.maxReworks,dependency_issues:unit.unit.dependsOn.map(key=>({key,issue_id:units.find(item=>item.unit.key === key)!.issueId}))},{base:previous.codeVersion,mode:policy.mode,binding:{parentIssueId:parent.issueId,parentRevision:unit.parentRevision,contractHash:unit.contractHash,mode:policy.mode}});
      record=this.current(actor.workspaceId,actor.issueId)!;
    }
    return this.initialManagedContinuation(record);
  }
  private initialManagedContinuation(record:Record){
    const role=this.activeRole(record),hash=createHash("sha256").update(`multica:engineering:continuation:${role.draftId}:0`).digest("hex");
    return {workspace_id:record.workspaceId,issue_id:record.issueId,parent_issue_id:record.managedBy!.parentIssueId,agent_id:role.agentId,user_id:record.createdBy,task_id:`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`,expected_revision:record.contract.binding.revision,expected_sequence:0,reason:"unit_ready"};
  }

  async invoke(input: ApplicationRequest) {
    const request = applicationRequestSchema.parse(input);
    const { actor, action } = request;
    if (actor.kind === "coordinator") {
      if (action !== "continuations") throw new Error("Coordinator credentials cannot edit engineering state");
      return [...await this.requirements.continuations(),...await this.managedProgress(),...await this.continuations()];
    }
    if (action === "continuations") throw new Error("Only the host coordinator can list continuations");
    const managedUnit=this.requirements.managedUnit(actor.workspaceId,actor.issueId);
    if(action === "parent-scope"){
      if(actor.kind !== "host")throw new Error("Only the host can inspect managed execution scope");
      const requirement=this.requirements.current(actor.workspaceId,actor.issueId);
      if(requirement?.reviews.length)return {managed:false,review_units:this.requirements.nativeRunUnits(requirement)};
      return managedUnit ? {managed:true,parent_issue_id:managedUnit.parentIssueId,contract_hash:managedUnit.contractHash,plan_draft_id:managedUnit.planDraftId,unit_issue_ids:this.requirements.executionContext(actor.workspaceId,actor.issueId)!.units.map(unit=>unit.issueId)} : {managed:false};
    }
    if(action === "delivery-policy")return this.requirements.deliveryPolicy(request);
    if(action === "activate-unit")return this.activateManaged(request);
    if(action === "accept-unit"){
      if(actor.kind !== "host")throw new Error("Only the host can accept verified native delivery");
      const result=await this.verifiedBinding(this.current(actor.workspaceId,actor.issueId));const expected=z.strictObject({binding:verificationContractSchema.shape.binding}).parse(request.payload);if(JSON.stringify(expected.binding) !== JSON.stringify(result.binding))throw new DraftConflictError("Verified delivery changed before native acceptance");return this.requirements.acceptUnit(request,result.binding);
    }
    if(managedUnit){
      if(action === "configure")throw new Error("Managed unit scope is frozen by its requirement plan");
      const managedRecord=this.current(actor.workspaceId,actor.issueId);
      if(!managedRecord){
        if(action === "overview" && actor.kind === "human")return {enabled:true,configured:false,managed_unit:managedUnit};
        if(action === "selection")throw new Error("Managed unit must wait for authorized execution and preceding verified deliveries");
        if(action === "completion" || action === "verified-binding")throw new DraftConflictError("Managed delivery has not completed independent verification");
        throw new Error("Managed unit must wait for authorized execution and preceding verified deliveries");
      }
      const context=this.requirements.executionContext(actor.workspaceId,actor.issueId)!;
      if(managedRecord.managedBy?.contractHash !== managedUnit.contractHash || context.policy.mode !== managedRecord.managedBy.mode)throw new Error("Managed contract no longer matches its frozen plan");
    }
    const requirement=this.requirements.current(actor.workspaceId,actor.issueId);
    const mode=z.object({kind:z.string().optional()}).passthrough().safeParse(request.payload);
    if(action === "configure" && mode.success && mode.data.kind === "requirement"){
      if(this.current(actor.workspaceId,actor.issueId))throw new Error("This issue already owns a delivery workflow; use a parent issue for requirement planning");
      return this.requirements.invoke(request);
    }
    if(requirement){
      if(action === "configure")throw new Error("This issue owns a requirement workflow; configure a requirement revision");
      if(action === "overview"){
        if(actor.kind !== "human")throw new Error("A human actor is required");
        const result=await this.requirements.overview(requirement);
        const progress=await Promise.all((result.requirement.publication?.units ?? []).map(async item=>{
          const current=this.current(actor.workspaceId,item.issueId),role=current ? this.activeRole(current) : null,draft=role ? await this.drafts.read(role.draftId) : null;
          return {key:item.unit.key,chain:role?.chain ?? null,status:draft?.status ?? (current ? "unstarted" : "pending"),stop_reason:current ? this.reworkView(current).stop_reason : null};
        }));
        return {...result,requirement:{...result.requirement,progress}};
      }
      return this.requirements.invoke(request);
    }
    const record = this.current(actor.workspaceId, actor.issueId);
    if (action === "overview" || action === "prepare-run") {
      if (actor.kind !== "human") throw new Error("A human actor is required for engineering controls");
      if (action === "overview") return this.overview(record);
      if (!record) throw new Error("Configure engineering before starting a run");
      await this.validateDependencies(record);
      const expected = z.strictObject({ expected_revision: sequence, expected_sequence: sequence, execution_resources: z.array(z.strictObject({ path: text, mode: z.enum(["in_place", "worktree"]) })).optional() }).parse(request.payload);
      const state = await this.overview(record);
      if (!("revision" in state)) throw new Error("Engineering contract is unavailable");
      if (expected.expected_revision !== state.revision || expected.expected_sequence !== state.sequence) throw new DraftConflictError("Engineering state changed; reload before starting a run");
      if (state.status === "abandoned" || state.chain === "verification" && state.status === "completed") throw new Error("Freeze a new contract before starting another run");
      if (state.status === "waiting_for_answers" && state.questions.some(input => input.active && input.answer === null)) throw new Error("Answer every pending question before starting a run");
      if (expected.execution_resources) {
        if (expected.execution_resources.length !== 1) throw new Error("Bind exactly one local project directory to the selected runtime");
        const resource = expected.execution_resources[0]!;
        const root = snapshot(resource.path, false).repositoryPath;
        if(record.managedBy && resource.mode !== record.managedBy.mode)throw new Error("Managed execution mode differs from its frozen policy");
        if (repositoryCommonDirectory(root) !== repositoryCommonDirectory(record.repositoryPath) || resource.mode === "in_place" && root !== record.repositoryPath) throw new Error("The project directory does not match the registered engineering repository");
      }
      return { ...(record.managedBy ? {parent_issue_id:record.managedBy.parentIssueId} : {}),agent_id: state.agent_id, revision: state.revision, sequence: state.sequence };
    }
    if(action === "verified-binding"){if(actor.kind !== "host")throw new Error("Only the host can read verified dependency bindings");return this.verifiedBinding(record);}
    if (action === "completion") {
      if (actor.kind !== "host") throw new Error("Only the host can authorize issue completion");
      if (!record) return { configured: false, allowed: true };
      if(record.analysis && !record.analysis.handoff)throw new DraftConflictError("Complete delivery analysis before issue completion");
      await this.validateDependencies(record);
      if (record.development && !record.development.handoff) throw new DraftConflictError("Development has not handed off its committed result");
      const draft = await this.drafts.read(record.draftId);
      if (!draft || draft.status !== "completed") throw new DraftConflictError("Complete independent verification before marking this issue done");
      const conclusion = compileVerificationConclusion(draft, record.contract);
      if (conclusion.verdict !== "passed") throw new DraftConflictError(`Independent verification failed; return to ${conclusion.rewindTo}`);
      if (!record.verificationExecution) throw new DraftConflictError("Verification has no runtime repository binding; freeze and verify a new revision");
      if (existsSync(record.verificationExecution.repositoryPath)) {
        const tested = snapshot(record.verificationExecution.repositoryPath, true, record.verificationExecution.overlays);
        if (tested.codeVersion !== record.contract.binding.codeVersion) throw new DraftConflictError("Repository commit changed after verification; freeze and verify a new revision");
      } else if (record.verificationExecution.mode === "in_place") throw new DraftConflictError("Verified in-place repository is unavailable");
      if (record.delivery?.mode === "worktree") {
        if (git(record.repositoryPath, ["rev-parse", "--verify", record.delivery.branchRef]) !== record.contract.binding.codeVersion) throw new DraftConflictError("Delivered branch changed after verification; freeze and verify a new revision");
      } else {
        const code = snapshot(record.repositoryPath, true, record.verificationExecution.mode === "in_place" ? record.verificationExecution.overlays : []);
        if (code.codeVersion !== record.contract.binding.codeVersion) throw new DraftConflictError("Repository commit changed after verification; freeze and verify a new revision");
      }
      return { configured: true, allowed: true, binding: conclusion.binding };
    }
    if (actor.kind === "host") throw new Error("Host completion credentials cannot edit chain state");
    if(action === "selection"){
      const role=record && this.activeRole(record);
      if(record && actor.kind === "task" && role?.agentId === actor.agentId)await this.validateDependencies(record);
      return {configured:actor.kind === "task" && role?.agentId === actor.agentId,chain:role?.chain ?? "verification",
        ...(record ? {...(record.managedBy ? {parent_issue_id:record.managedBy.parentIssueId} : {}),repository_path:record.repositoryPath,code_version:role?.chain === "analysis" ? record.analysis!.contract.binding.codeVersion : this.selectionCommit(record)} : {})};
    }
    if (action === "configure") {if(actor.kind !== "human")throw new Error("Only a human can freeze verification contracts");return this.configureDelivery(actor,request.payload);}
    if (!record) throw new Error("No verification contract is configured for this issue");
    if (action === "bind") {
      if (actor.kind !== "daemon") throw new Error("Only the runtime can bind execution repositories");
      await this.validateDependencies(record);
      const analysis=Boolean(record.analysis && actor.agentId === record.analysis.agentId);
      if(record.analysis && !record.analysis.handoff && !analysis)throw new Error("Analysis has not handed off its frozen delivery contract");
      const development = !analysis && Boolean(record.development && !record.development.handoff && actor.agentId === record.development.agentId);
      if (!analysis && !development && actor.agentId === record.agentId && record.development && !record.development.handoff) throw new Error("Development has not handed off a verified commit yet");
      if (!analysis && !development && actor.agentId !== record.agentId) throw new Error("Run agent does not own this verification role");
      const payload = z.strictObject({ work_dir: text, mode: z.enum(["in_place", "worktree"]), overlays: z.array(z.strictObject({ path: text, hash: z.string().regex(/^[a-f0-9]{64}$/) })).max(5000) }).parse(request.payload);
      const code = snapshot(payload.work_dir, false);
      if (repositoryCommonDirectory(code.repositoryPath) !== repositoryCommonDirectory(record.repositoryPath)) throw new Error("Execution repository is not a worktree of the registered repository");
      if(record.managedBy && payload.mode !== record.managedBy.mode)throw new Error("Managed execution mode differs from its frozen policy");
      if (payload.mode === "in_place" && code.repositoryPath !== record.repositoryPath) throw new Error("In-place execution must use the registered repository");
      const overlays = captureRepositoryOverlays(code.repositoryPath, payload.overlays, !development);
      if (development) git(code.repositoryPath, ["merge-base", "--is-ancestor", record.development!.baseCodeVersion, code.codeVersion]);
      else if (code.codeVersion !== (analysis ? record.analysis!.contract.binding.codeVersion : record.contract.binding.codeVersion)) throw new Error("Verification execution is not at the frozen delivery commit or analysis snapshot");
      const branchRef = git(code.repositoryPath, ["rev-parse", "--abbrev-ref", "HEAD"]) === "HEAD" ? "" : repositoryBranch(code.repositoryPath);
      if (development && payload.mode === "worktree" && !branchRef) throw new Error("Worktree development requires a durable branch");
      const execution = executionSchema.parse({ repositoryPath: code.repositoryPath, mode: payload.mode, branchRef, agentId: actor.agentId, attemptId: actor.attemptId, overlays });
      const previous = this.db.prepare("SELECT payload FROM engineering_execution WHERE workspace_id = ? AND issue_id = ? AND revision = ? AND agent_id = ? AND attempt_id = ?")
        .get(record.workspaceId, record.issueId, record.contract.binding.revision, actor.agentId, actor.attemptId);
      const identity = (value: Execution) => ({ ...value, overlays: value.overlays.map(({ hash: _hash, ...overlay }) => overlay).sort((a, b) => a.path.localeCompare(b.path)) });
      if (previous && JSON.stringify(identity(executionSchema.parse(JSON.parse(String(previous.payload))))) !== JSON.stringify(identity(execution))) throw new DraftConflictError("Execution binding changed; start a fresh runtime claim");
      this.db.prepare("INSERT INTO engineering_execution (workspace_id, issue_id, revision, agent_id, attempt_id, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, issue_id, revision, agent_id, attempt_id) DO UPDATE SET payload = excluded.payload")
        .run(record.workspaceId, record.issueId, record.contract.binding.revision, actor.agentId, actor.attemptId, JSON.stringify(execution));
      return { bound: true, repository_path: execution.repositoryPath };
    }
    if (action === "receipt") {
      if (actor.kind !== "daemon") throw new Error("Only the runtime can capture command receipts");
      if (!record.development || actor.agentId !== record.development.agentId || record.development.handoff) return { ignored: true };
      const execution = this.execution(record, actor);
      const payload = z.strictObject({ id: text, sequence, command: text, cwd: text, status: text, exit_code: z.number().int().nullable() }).parse(request.payload);
      if (payload.command.toLowerCase().includes("multica") && payload.command.includes(" engineering ")) return { ignored: true };
      if (snapshot(payload.cwd, false).repositoryPath !== execution.repositoryPath) throw new Error("Command receipt belongs to another execution repository");
      const id = `${actor.attemptId}:${payload.id}`;
      const previous = this.runtime(record).receipts().find(item => item.id === id);
      if (previous) {
        if (previous.sequence !== payload.sequence || previous.command !== payload.command || previous.cwd !== payload.cwd || previous.status !== payload.status || previous.exitCode !== payload.exit_code) throw new DraftConflictError("Receipt identity cannot be rewritten");
        return { captured: previous.id };
      }
      const receipt = commandReceiptSchema.parse({ id, attemptId: actor.attemptId, sequence: payload.sequence, command: payload.command,
        commandHash: createHash("sha256").update(JSON.stringify([payload.command, payload.cwd])).digest("hex"), cwd: payload.cwd,
        status: payload.status, exitCode: payload.exit_code, fingerprint: repositoryFingerprint(execution.repositoryPath, execution.overlays) });
      this.db.prepare("INSERT INTO engineering_receipt (draft_id, receipt_id, payload) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(record.development.draftId, receipt.id, JSON.stringify(receipt));
      return { captured: receipt.id };
    }
    if (actor.kind === "daemon") throw new Error("Runtime credentials cannot edit chain state");
    if(record.analysis && (actor.kind === "task" ? actor.agentId === record.analysis.agentId : !record.analysis.handoff)){
      if(actor.kind === "human" && !["read","answer","abandon"].includes(action))throw new Error("This operation requires the configured run credential");
      if(actor.kind === "task" && !["read","start","command"].includes(action))throw new Error("This operation requires a human actor");
      return this.invokeAnalysis(record,actor,action,request.payload);
    }
    if(record.analysis && !record.analysis.handoff)throw new Error("Analysis has not handed off its frozen delivery contract");
    await this.validateDependencies(record);
    const development = Boolean(record.development && (actor.kind === "task" ? actor.agentId === record.development.agentId : !record.development.handoff));
    if (actor.kind === "task" && !development && actor.agentId !== record.agentId) throw new Error("Run agent does not own this verification role");
    if (actor.kind === "task" && !development && record.development && !record.development.handoff) throw new Error("Development has not handed off a verified commit yet");
    if (actor.kind === "human" && action !== "read" && action !== "answer" && action !== "abandon") throw new Error("This operation requires the configured run credential");
    if (actor.kind === "task" && action !== "read" && action !== "start" && action !== "command") throw new Error("This operation requires a human actor");
    const execution = actor.kind === "task" ? this.execution(record, actor) : undefined;
    const engine = this.engine(record, development, execution);
    const draftId = development ? record.development!.draftId : record.draftId;
    let draft = await this.drafts.read(draftId);
    if (actor.kind === "task") {
      const code = snapshot(execution!.repositoryPath, !development, execution!.overlays);
      if (development) git(execution!.repositoryPath, ["merge-base", "--is-ancestor", record.development!.baseCodeVersion, code.codeVersion]);
      else if (code.codeVersion !== record.contract.binding.codeVersion) throw new Error("Repository commit changed; freeze a new verification revision");
    }
    if (action === "start" && actor.kind === "task") {
      if (!draft && !development && record.reworkFrom?.kind === "implementation") {
        const previous = this.revision(record.workspaceId, record.issueId, record.reworkFrom.revision);
        const failed = await this.drafts.read(record.reworkFrom.draftId);
        if (!previous || !failed) throw new Error("Recheck history is unavailable");
        draft = createVerificationRecheck(failed, previous.contract, record.contract, draftId, actor.attemptId);
        await this.drafts.create(draft);
      } else if (!draft) draft = await engine.create({ id: draftId, chain: parseCommandChainDefinition(development ? record.development!.definitionSource : record.definitionSource, development ? developmentProfile : profile), binding: development ? this.devContract(record).binding : record.contract.binding, attemptId: actor.attemptId });
      else if (draft.status === "abandoned") throw new Error("Verification draft is abandoned; freeze a new revision");
      else if (draft.status !== "completed" && draft.attemptId !== actor.attemptId) draft = await engine.resume(draft.id, draft.sequence, actor.attemptId);
    } else if (action !== "read") {
      if (!draft) throw new Error("Start the verification draft before editing or answering");
      if (action === "command" && actor.kind === "task") {
        const command = z.strictObject({ expected_sequence: sequence, command: chainCommandSchema }).parse(request.payload);
        if (!development && record.reworkFrom?.kind === "implementation" && command.command.type === "phase.rewind") {
          const target = command.command.to;
          const phases = Object.entries(draft.definition.phases);
          const execute = phases.findIndex(([_, phase]) => phase.type === "builtin" && phase.builtin === "verification-execution");
          if (phases.findIndex(([id]) => id === target) < execute) throw new Error("Recheck retains the frozen scenarios; a new human contract is required to change the plan");
        }
        if (development && command.command.type === "phase.complete" && (draft.phase === "commit" || draft.phase === "finalize")) snapshot(execution!.repositoryPath, true, execution!.overlays);
        draft = await engine.execute(draft.id, { attemptId: actor.attemptId, expectedSequence: command.expected_sequence }, command.command);
      } else if (action === "answer" && actor.kind === "human") {
        const answer = z.strictObject({ expected_sequence: sequence, request_id: text, answer: text }).parse(request.payload);
        draft = await engine.answerRuntimeInput(draft.id, { expectedSequence: answer.expected_sequence, requestId: answer.request_id, answer: answer.answer, userId: actor.userId });
      } else if (action === "abandon" && actor.kind === "human") {
        const abandon = z.strictObject({ expected_sequence: sequence, reason: text }).parse(request.payload);
        draft = await engine.abandon(draft.id, abandon.expected_sequence, abandon.reason, actor.userId);
      }
    }
    if (actor.kind === "task" && development && draft?.status === "completed" && !record.development!.handoff) {
      const code = snapshot(execution!.repositoryPath, true, execution!.overlays);
      const conclusion = compileDevelopmentConclusion(draft, this.devContract(record), this.runtime(record, execution));
      record.development!.conclusion = JSON.parse(JSON.stringify({ ...conclusion, commit: code.codeVersion }));
      record.development!.handoff = true;
      record.contract.binding.codeVersion = code.codeVersion;
      record.delivery = execution;
      this.save(record);
    }
    if (actor.kind === "task" && !development && draft?.status === "completed") {
      record.verificationExecution = execution;
      this.save(record);
    }
    const view = this.view(record, draft, development, execution);
    if (actor.kind === "task" && !development && draft?.status === "completed") this.settleFailure(record, draft);
    const result = { ...view, rework: this.reworkView(this.current(record.workspaceId, record.issueId) ?? record) };
    return actor.kind === "human" ? { ...result, developmentConclusion: record.development?.conclusion ?? null } : result;
  }

  close() { this.drafts.close(); this.db.close(); }
}
