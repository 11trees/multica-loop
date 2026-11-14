import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ApplicationRequest } from "./application";
import { artifactBlock } from "./artifacts";
import { businessContractSchema, businessProfiles, businessStageSchema, compileBusinessConclusion, createBusinessHandlers, type BusinessConclusion, type BusinessStage } from "./business";
import { decisionModeSchema, decisionPolicies, decisionProposalSchema } from "./decisions";
import { parseCommandChainDefinition } from "./definition";
import { captureRepositoryOverlays, git, repositoryBranch, repositoryCommonDirectory, repositorySnapshot } from "./repository";
import { CommandChainEngine, DraftConflictError, chainCommandSchema, draftSchema, type ChainDraft } from "./runtime";
import type { SqliteDraftStore } from "./sqlite-store";

const text = z.string().trim().min(1), sequence = z.number().int().nonnegative();
const stages = ["intent", "business_design", "specification", "review"] as const;
const roles = z.strictObject({ intent: z.uuid(), business_design: z.uuid(), specification: z.uuid(), review: z.uuid() });
const sources = z.strictObject({ intent: text, business_design: text, specification: text, review: text });
export type BusinessDefinitions = z.infer<typeof sources>;
const resource = z.strictObject({ path: text, mode: z.enum(["in_place", "worktree"]) });
const configuration = z.strictObject({ expected_revision: z.literal(0), project_id: z.uuid(), repository_path: text, input: text.max(40000),
  roles, decision_mode: decisionModeSchema, auto_continue: z.boolean(), execution_resources: z.array(resource).length(4) });
const entrySchema = z.strictObject({ stage: businessStageSchema, generation: z.number().int().positive(), draftId: z.uuid(), contract: businessContractSchema,
  upstream: z.array(z.uuid()), previousDraftId: z.uuid().optional(), triggerDraftId: z.uuid().optional(), reason: text.optional(), settledHash: text.optional(), superseded: z.boolean() });
type Entry = z.infer<typeof entrySchema>;
const recordSchema = z.strictObject({ workspaceId: z.uuid(), issueId: z.uuid(), projectId: z.uuid(), revision: z.literal(1), version: sequence,
  createdBy: z.uuid(), repositoryPath: text, codeVersion: text, input: text.max(40000), roles, sources, decisionMode: decisionModeSchema,
  autoContinue: z.boolean(), mode: z.enum(["in_place", "worktree"]), entries: z.array(entrySchema).min(1), activeDraftId: z.uuid() });
type Record = z.infer<typeof recordSchema>;
const executionSchema = z.strictObject({ draftId: z.uuid(), repositoryPath: text, mode: z.enum(["in_place", "worktree"]), branchRef: text.nullable(),
  overlays: z.array(z.strictObject({ path: text, hash: text, executable: z.boolean(), originalHash: text.nullable(), originalExecutable: z.boolean() })) });
type Execution = z.infer<typeof executionSchema>;
function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function stableId(value: string) { const hash = fingerprint(value); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`; }

/** Native business checkpoints; session/task authentication remains in Go. */
export class BusinessApplication {
  constructor(private readonly db: DatabaseSync, private readonly drafts: SqliteDraftStore, private readonly definitions?: BusinessDefinitions) {
    db.exec("CREATE TABLE IF NOT EXISTS business_contract (workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,revision INTEGER NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id,revision))");
    db.exec("CREATE TABLE IF NOT EXISTS business_execution (workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,revision INTEGER NOT NULL,agent_id TEXT NOT NULL,attempt_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id,revision,agent_id,attempt_id))");
    if (definitions) for (const stage of stages) parseCommandChainDefinition(definitions[stage], businessProfiles[stage]);
  }
  current(workspaceId: string, issueId: string): Record | undefined {
    const row = this.db.prepare("SELECT payload FROM business_contract WHERE workspace_id=? AND issue_id=? ORDER BY revision DESC LIMIT 1").get(workspaceId, issueId);
    return row ? recordSchema.parse(JSON.parse(String(row.payload))) : undefined;
  }
  private active(record: Record) { const entry = record.entries.find(item => item.draftId === record.activeDraftId && !item.superseded); if (!entry) throw new Error("Business checkpoint is unavailable"); return entry; }
  private save(record: Record) {
    const expected = record.version; record.version++;
    const changed = this.db.prepare("UPDATE business_contract SET version=?,payload=? WHERE workspace_id=? AND issue_id=? AND revision=? AND version=?")
      .run(record.version, JSON.stringify(record), record.workspaceId, record.issueId, record.revision, expected);
    if (changed.changes !== 1) throw new DraftConflictError("Business workflow changed; reload the current checkpoint");
  }
  private stored(entry: Entry) {
    const row = this.db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(entry.draftId);
    if (!row) throw new Error("Business draft history is unavailable");
    return draftSchema.parse(JSON.parse(String(row.payload)));
  }
  private conclusion(record: Record, entry: Entry): BusinessConclusion {
    const draft = this.stored(entry), expected = parseCommandChainDefinition(record.sources[entry.stage], businessProfiles[entry.stage]);
    if (JSON.stringify(draft.definition) !== JSON.stringify(expected.definition)) throw new DraftConflictError("Frozen business definition changed");
    const result = compileBusinessConclusion(draft, entry.contract);
    if (entry.settledHash && fingerprint(result) !== entry.settledHash) throw new DraftConflictError("Accepted business conclusion changed");
    return result;
  }
  private entry(record: Omit<Record, "entries" | "activeDraftId"> & { entries: Entry[] }, stage: BusinessStage, trigger?: Entry): Entry {
    const previous = record.entries.findLast(item => item.stage === stage);
    const upstream = stages.slice(0, stages.indexOf(stage)).map(input => {
      const entry = record.entries.findLast(item => item.stage === input && !item.superseded && item.settledHash);
      if (!entry || this.conclusion(record as Record, entry).disposition === "return_revision") throw new Error(`Business ${stage} requires current ${input}`);
      return entry;
    });
    const generation = (previous?.generation ?? 0) + 1, draftId = randomUUID();
    const contractVersion = fingerprint({ input: record.input, stage, generation, roles: record.roles, projectId: record.projectId,
      source: record.sources[stage], decisionMode: record.decisionMode, upstream: upstream.map(entry => this.conclusion(record as Record, entry)),
      ...(previous ? { previous: this.conclusion(record as Record, previous) } : {}), ...(trigger ? { trigger: this.conclusion(record as Record, trigger) } : {}) });
    return entrySchema.parse({ stage, generation, draftId, upstream: upstream.map(entry => entry.draftId), superseded: false,
      ...(previous ? { previousDraftId: previous.draftId } : {}), ...(trigger ? { triggerDraftId: trigger.draftId, reason: this.conclusion(record as Record, trigger).disposition === "return_revision" ? "Address the frozen upstream gaps" : "Reassess the upstream output" } : {}),
      contract: { stage, decisionMode: record.decisionMode, binding: { workspaceId: record.workspaceId, issueId: record.issueId, revision: record.revision, contractVersion, codeVersion: record.codeVersion } } });
  }
  private execution(record: Record, entry: Entry, agentId: string, attemptId: string): Execution {
    const row = this.db.prepare("SELECT payload FROM business_execution WHERE workspace_id=? AND issue_id=? AND revision=? AND agent_id=? AND attempt_id=?").get(record.workspaceId, record.issueId, record.revision, agentId, attemptId);
    if (!row) throw new Error("Bind the business runtime repository first");
    const execution = executionSchema.parse(JSON.parse(String(row.payload)));
    if (execution.draftId !== entry.draftId) throw new DraftConflictError("Native business attempt belongs to another checkpoint");
    return execution;
  }
  private readonlyExecution(record: Record, entry: Entry, execution: Execution, terminal = false) {
    if (execution.mode !== record.mode) throw new DraftConflictError("Business execution mode changed");
    if (execution.mode === "worktree" && (!execution.branchRef || git(record.repositoryPath, ["rev-parse", "--verify", execution.branchRef]) !== entry.contract.binding.codeVersion)) throw new DraftConflictError("Retained business branch changed from the frozen commit");
    if (existsSync(execution.repositoryPath)) {
      if (repositorySnapshot(execution.repositoryPath, true, execution.overlays).codeVersion !== entry.contract.binding.codeVersion) throw new DraftConflictError("Readonly business repository changed from the frozen snapshot");
    } else if (!terminal || execution.mode !== "worktree") throw new DraftConflictError("Business runtime repository is unavailable");
  }
  private settle(record: Record, entry: Entry, draft: ChainDraft) {
    if (entry.settledHash || draft.status !== "completed") return;
    this.readonlyExecution(record, entry, this.execution(record, entry, record.roles[entry.stage], draft.attemptId), true);
    const result = this.conclusion(record, entry); entry.settledHash = fingerprint(result);
    if (result.disposition === "return_revision") {
      for (const previous of record.entries) if (stages.indexOf(previous.stage) >= stages.indexOf(result.target)) previous.superseded = true;
      const next = this.entry(record, result.target, entry); record.entries.push(next); record.activeDraftId = next.draftId;
    } else if (result.disposition !== "approved") {
      const next = this.entry(record, stages[stages.indexOf(entry.stage) + 1]!); record.entries.push(next); record.activeDraftId = next.draftId;
    }
    this.save(record);
  }
  private async configure(request: ApplicationRequest) {
    const actor = request.actor;
    if (actor.kind !== "human" || !this.definitions) throw new Error("Only a human can configure business analysis with registered definitions");
    const input = configuration.parse(request.payload), code = repositorySnapshot(input.repository_path), mode = input.execution_resources[0]!.mode;
    if (new Set(Object.values(input.roles)).size !== 4) throw new Error("Business analysis requires four separate native role agents");
    if (input.execution_resources.some(resource => resource.mode !== mode || repositorySnapshot(resource.path, false).repositoryPath !== code.repositoryPath)) throw new Error("All business roles must use one registered project repository and execution mode");
    const base = { workspaceId: actor.workspaceId, issueId: actor.issueId, projectId: input.project_id, revision: 1 as const, version: 0, createdBy: actor.userId,
      repositoryPath: code.repositoryPath, codeVersion: code.codeVersion, input: input.input, roles: input.roles, sources: structuredClone(this.definitions), decisionMode: input.decision_mode,
      autoContinue: input.auto_continue, mode, entries: [] as Entry[] };
    const entry = this.entry(base, "intent"), record = recordSchema.parse({ ...base, entries: [entry], activeDraftId: entry.draftId });
    const changed = this.db.prepare(`INSERT INTO business_contract(workspace_id,issue_id,revision,version,payload)
      SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM requirement_contract WHERE workspace_id=? AND issue_id=?)
      AND NOT EXISTS(SELECT 1 FROM engineering_contract WHERE workspace_id=? AND issue_id=?)
      AND NOT EXISTS(SELECT 1 FROM requirement_unit WHERE workspace_id=? AND issue_id=?) ON CONFLICT DO NOTHING`)
      .run(record.workspaceId, record.issueId, 1, 0, JSON.stringify(record), record.workspaceId, record.issueId, record.workspaceId, record.issueId, record.workspaceId, record.issueId);
    if (changed.changes !== 1) throw new DraftConflictError("This issue already owns an engineering workflow; reconcile it before replacement");
    return this.view(record, entry);
  }
  async continuations() {
    const pending = [];
    for (const row of this.db.prepare("SELECT payload FROM business_contract").all()) {
      const record = recordSchema.parse(JSON.parse(String(row.payload))); let entry = this.active(record), draft = await this.drafts.read(entry.draftId);
      if (draft?.status === "completed" && !entry.settledHash) { this.settle(record, entry, draft); entry = this.active(record); draft = await this.drafts.read(entry.draftId); }
      if (!record.autoContinue || draft?.status === "abandoned" || draft?.status === "completed") continue;
      const reason = !draft ? "business_ready" : draft.status === "waiting_for_answers" && draft.runtimeInputs.some(input => input.active) && draft.runtimeInputs.every(input => !input.active || input.answer) ? "human_answers" : null;
      if (reason) pending.push({ workspace_id: record.workspaceId, issue_id: record.issueId, agent_id: record.roles[entry.stage], user_id: record.createdBy,
        task_id: stableId(`multica:business:${entry.draftId}:${draft?.sequence ?? 0}`), expected_revision: record.revision, expected_sequence: draft?.sequence ?? 0, reason });
    }
    return pending;
  }
  async invoke(request: ApplicationRequest) {
    const { actor, action } = request;
    if (action === "configure-business") return this.configure(request);
    if (actor.kind === "coordinator") throw new Error("Use the business continuation coordinator");
    const record = this.current(actor.workspaceId, actor.issueId); if (!record) throw new Error("Business analysis is not configured");
    const entry = this.active(record), agentId = record.roles[entry.stage]; let draft = await this.drafts.read(entry.draftId);
    if (action === "configure") throw new Error("This issue owns business analysis; reconcile its inputs before replacing the workflow");
    if (action === "completion" || action === "verified-binding") throw new DraftConflictError("Business analysis does not authorize delivered-code completion; versioned specification reading remains to be connected");
    if (action === "overview") {
      if (actor.kind !== "human") throw new Error("A human actor is required");
      if (draft?.status === "completed" && !entry.settledHash) { this.settle(record, entry, draft); const next = this.active(record); return this.overview(record, next, await this.drafts.read(next.draftId)); }
      return this.overview(record, entry, draft);
    }
    if (action === "selection") return { configured: actor.kind === "task" && actor.agentId === agentId && !entry.settledHash, chain: businessProfiles[entry.stage].id,
      business_project_id: record.projectId, repository_path: record.repositoryPath, code_version: entry.contract.binding.codeVersion };
    if ((actor.kind === "task" || actor.kind === "daemon") && actor.projectId !== record.projectId) throw new DraftConflictError("Native business project changed from its frozen scope");
    if (action === "prepare-run") {
      if (actor.kind !== "human") throw new Error("Only a human can authorize a business run");
      const input = z.strictObject({ expected_revision: sequence, expected_sequence: sequence, execution_resources: z.array(resource).optional() }).parse(request.payload);
      if (input.expected_revision !== record.revision || input.expected_sequence !== (draft?.sequence ?? 0)) throw new DraftConflictError("Business checkpoint changed");
      if (entry.settledHash || draft?.status === "completed" || draft?.status === "abandoned") throw new Error("Business checkpoint is terminal; do not restart its native run");
      if (draft?.runtimeInputs.some(item => item.active && !item.answer)) throw new Error("Answer all business questions before continuing");
      if (input.execution_resources && (input.execution_resources.length !== 1 || input.execution_resources.some(item => item.mode !== record.mode || repositorySnapshot(item.path, false).repositoryPath !== record.repositoryPath))) throw new Error("Bind the frozen business project repository and mode");
      return { agent_id: agentId, revision: record.revision, sequence: draft?.sequence ?? 0, business_project_id: record.projectId };
    }
    if (action === "bind") {
      if (actor.kind !== "daemon" || actor.agentId !== agentId || entry.settledHash) throw new Error("Only the active business runtime can bind its repository");
      const input = z.strictObject({ work_dir: text, mode: z.enum(["in_place", "worktree"]), overlays: z.array(z.strictObject({ path: text, hash: text })) }).parse(request.payload);
      const root = repositorySnapshot(input.work_dir, false).repositoryPath;
      if (input.mode !== record.mode || repositoryCommonDirectory(root) !== repositoryCommonDirectory(record.repositoryPath) || input.mode === "in_place" && root !== record.repositoryPath) throw new Error("Business runtime must use the frozen project repository and mode");
      const execution = executionSchema.parse({ draftId: entry.draftId, repositoryPath: root, mode: input.mode,
        branchRef: input.mode === "worktree" ? repositoryBranch(root) : null, overlays: captureRepositoryOverlays(root, input.overlays, true) });
      this.readonlyExecution(record, entry, execution);
      const existing = this.db.prepare("SELECT payload FROM business_execution WHERE workspace_id=? AND issue_id=? AND revision=? AND agent_id=? AND attempt_id=?").get(record.workspaceId, record.issueId, record.revision, actor.agentId, actor.attemptId);
      if (existing && JSON.stringify(executionSchema.parse(JSON.parse(String(existing.payload)))) !== JSON.stringify(execution)) throw new DraftConflictError("Native business attempt binding cannot be replaced");
      this.db.prepare("INSERT INTO business_execution(workspace_id,issue_id,revision,agent_id,attempt_id,payload) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING")
        .run(record.workspaceId, record.issueId, record.revision, actor.agentId, actor.attemptId, JSON.stringify(execution));
      return { bound: true, repository_path: root };
    }
    if (actor.kind !== "human" && actor.kind !== "task") throw new Error("Authenticated business control is required");
    if (actor.kind === "task") {
      if (actor.agentId !== agentId || entry.settledHash) throw new Error("Task does not own the active business checkpoint");
      this.readonlyExecution(record, entry, this.execution(record, entry, actor.agentId, actor.attemptId));
    }
    const engine = new CommandChainEngine(this.drafts, createBusinessHandlers(entry.contract));
    if (action === "start" && actor.kind === "task") {
      if (!draft) {
        let inheritedChoices: Pick<ChainDraft, "decisions" | "runtimeInputs"> | undefined;
        if (entry.previousDraftId) {
          const previous = record.entries.find(item => item.draftId === entry.previousDraftId)!;
          const conclusion = this.conclusion(record, previous);
          // Retain dependencies and the authenticated option snapshots in the same initial store write.
          if (conclusion.decisions.some(node => node.resolution?.authority === "user")) inheritedChoices = {
            decisions: conclusion.decisions.map(node => node.resolution?.authority === "user" ? node : { ...node, status: "proposed" as const, resolution: undefined }),
            runtimeInputs: conclusion.runtimeInputs,
          };
        }
        draft = await engine.create({ id: entry.draftId, chain: parseCommandChainDefinition(record.sources[entry.stage], businessProfiles[entry.stage]), binding: entry.contract.binding, attemptId: actor.attemptId, inheritedChoices });
      } else if (draft.status === "abandoned") throw new Error("Business draft was abandoned");
      else if (draft.status !== "completed" && draft.attemptId !== actor.attemptId) draft = await engine.resume(draft.id, draft.sequence, actor.attemptId);
    } else if (action !== "read") {
      if (!draft) throw new Error("Start the business checkpoint first");
      if (action === "command" && actor.kind === "task") { const input = z.strictObject({ expected_sequence: sequence, command: chainCommandSchema }).parse(request.payload); draft = await engine.execute(draft.id, { expectedSequence: input.expected_sequence, attemptId: actor.attemptId }, input.command); }
      else if (action === "answer" && actor.kind === "human") { const input = z.strictObject({ expected_sequence: sequence, request_id: text, answer: z.string().max(20000), selected_option: text.optional() }).parse(request.payload); draft = await engine.answerRuntimeInput(draft.id, { expectedSequence: input.expected_sequence, requestId: input.request_id, answer: input.answer, userId: actor.userId, selectedOption: input.selected_option }); }
      else if (action === "abandon" && actor.kind === "human") { const input = z.strictObject({ expected_sequence: sequence, reason: text }).parse(request.payload); draft = await engine.abandon(draft.id, input.expected_sequence, input.reason, actor.userId); }
      else throw new Error("Operation is outside this authenticated business checkpoint");
    }
    const view = this.view(record, entry, draft);
    if (draft?.status === "completed") this.settle(record, entry, draft);
    return view;
  }
  private view(record: Record, entry: Entry, draft?: ChainDraft) {
    const phase = draft?.phase ? draft.definition.phases[draft.phase] : undefined;
    const referenced = (id: string) => this.conclusion(record, record.entries.find(item => item.draftId === id)!);
    return { chain: businessProfiles[entry.stage].id, agentId: record.roles[entry.stage], repositoryPath: record.repositoryPath, contract: entry.contract, draft: draft ?? null,
      business: { originalInput: record.input, projectId: record.projectId, stage: entry.stage, generation: entry.generation,
        upstream: entry.upstream.map(referenced), previous: entry.previousDraftId ? referenced(entry.previousDraftId) : null, returnReason: entry.triggerDraftId ? referenced(entry.triggerDraftId) : null },
      instructions: `Business analysis is readonly. Preserve the original input and exact frozen upstream source versions, research and human choices. Never change repository files or claim software delivery. ${phase?.type === "builtin" ? `${phase.builtin}: register and close only this stage's decisions; gaps return to their sole responsibility owner. Independent review may approve the complete specification or return structured gaps.` : phase?.instructions ?? "Read the frozen stage inputs."} ${decisionPolicies[record.decisionMode]}`,
      decisionSchema: z.toJSONSchema(decisionProposalSchema), conclusion: draft?.status === "completed" ? this.conclusion(record, entry) : null, receipts: [] };
  }
  private overview(record: Record, entry: Entry, draft?: ChainDraft) {
    return { enabled: true, configured: true, auto_continue: record.autoContinue, chain: businessProfiles[entry.stage].id, agent_id: record.roles[entry.stage], revision: record.revision,
      sequence: draft?.sequence ?? 0, code_version: entry.contract.binding.codeVersion, repository_path: record.repositoryPath, draft_id: draft?.id ?? null, status: draft?.status ?? "unstarted", current_phase: draft?.phase ?? null,
      phases: Object.keys(parseCommandChainDefinition(record.sources[entry.stage], businessProfiles[entry.stage]).definition.phases).map(id => ({ id, status: draft?.completedPhases.includes(id) ? "completed" : id === draft?.phase ? "current" : "pending" })),
      sources: [], decisions: draft?.decisions ?? [], artifacts: draft?.artifacts.map(item => ({ ...item, title: artifactBlock(draft.definition, item.ref).title })) ?? [],
      questions: (draft?.runtimeInputs ?? []).map(input => ({ ...input, decision_key: input.decisionKey, recommendation_option: input.recommendationOption, answer: input.answer ? { text: input.answer.text, user_id: input.answer.userId, sequence: input.answer.sequence, selected_option: input.answer.selectedOption } : null })),
      business: { input: record.input, project_id: record.projectId, stage: entry.stage, generation: entry.generation, reading_enabled: false,
        history: record.entries.map(item => ({ stage: item.stage, generation: item.generation, draft_id: item.draftId, superseded: item.superseded, settled: !!item.settledHash,
          result: item.settledHash ? this.conclusion(record, item) : null })) }, result: null };
  }
}
