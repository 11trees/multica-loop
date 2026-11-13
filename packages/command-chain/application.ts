import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { z } from "zod";
import { parseCommandChainDefinition, type CommandChainProfile } from "./definition";
import { CommandChainEngine, DraftConflictError, chainCommandSchema, type ChainDraft } from "./runtime";
import { SqliteDraftStore } from "./sqlite-store";
import { compileVerificationConclusion, createVerificationHandlers, verificationContractSchema } from "./verification";
import { commandReceiptSchema, createDevelopmentHandlers, compileDevelopmentConclusion, type CommandReceipt } from "./development";
import { git, repositorySnapshot as snapshot, repositoryFingerprint, repositoryCommonDirectory, repositoryBranch, captureRepositoryOverlays } from "./repository";
import { artifactBlock } from "./artifacts";

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
  action: z.enum(["configure", "read", "start", "command", "answer", "abandon", "selection", "receipt", "completion", "bind", "overview", "prepare-run", "continuations"]),
  payload: z.unknown().optional(),
});
export type ApplicationRequest = z.infer<typeof applicationRequestSchema>;
const configuration = z.strictObject({
  expected_revision: sequence,
  agent_id: z.uuid(), repository_path: text,
  developer_agent_id: z.uuid().optional(),
  implementation_guidance: text.optional(),
  auto_continue: z.boolean().optional().default(false),
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
  contract: verificationContractSchema,
  development: z.strictObject({ agentId: z.uuid(), draftId: z.uuid(), definitionSource: text, baseCodeVersion: text, implementationGuidance: text, handoff: z.boolean(), conclusion: z.json().optional() }).optional(),
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

  constructor(database: string, private readonly definitionSource: string, private readonly developmentSource?: string) {
    parseCommandChainDefinition(definitionSource, profile);
    this.db = new DatabaseSync(database);
    this.db.exec(`CREATE TABLE IF NOT EXISTS engineering_contract (
      workspace_id TEXT NOT NULL, issue_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (workspace_id, issue_id, revision)
    )`);
    this.drafts = new SqliteDraftStore(database);
    this.db.exec("CREATE TABLE IF NOT EXISTS engineering_receipt (draft_id TEXT NOT NULL, receipt_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (draft_id, receipt_id))");
    this.db.exec("CREATE TABLE IF NOT EXISTS engineering_execution (workspace_id TEXT NOT NULL, issue_id TEXT NOT NULL, revision INTEGER NOT NULL, agent_id TEXT NOT NULL, attempt_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (workspace_id, issue_id, revision, agent_id, attempt_id))");
  }

  private current(workspaceId: string, issueId: string): Record | undefined {
    const row = this.db.prepare("SELECT payload FROM engineering_contract WHERE workspace_id = ? AND issue_id = ? ORDER BY revision DESC LIMIT 1").get(workspaceId, issueId);
    return row ? recordSchema.parse(JSON.parse(String(row.payload))) : undefined;
  }

  private devContract(record: Record) {
    return { ...record.contract, implementationGuidance: record.development!.implementationGuidance, binding: { ...record.contract.binding, codeVersion: record.development!.baseCodeVersion } };
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
    const commit = previous?.mode === "worktree" && previous.branchRef ? git(record.repositoryPath, ["rev-parse", "--verify", previous.branchRef]) : snapshot(record.repositoryPath, false).codeVersion;
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
      receipts: development ? this.runtime(record).receipts() : [],
      conclusion: draft?.status === "completed" ? development ? record.development!.conclusion ?? null : compileVerificationConclusion(draft, record.contract) : null,
    };
  }

  private async overview(record: Record | undefined) {
    if (!record) return { enabled: true, configured: false };
    const development = Boolean(record.development && !record.development.handoff);
    const draft = await this.drafts.read(development ? record.development!.draftId : record.draftId);
    const definition = draft?.definition ?? parseCommandChainDefinition(development ? record.development!.definitionSource : record.definitionSource, development ? developmentProfile : profile).definition;
    const conclusion = draft?.status === "completed" ? development ? record.development?.conclusion : compileVerificationConclusion(draft, record.contract) : undefined;
    return {
      enabled: true, configured: true, auto_continue: record.autoContinue, chain: development ? "development" : "verification",
      agent_id: development ? record.development!.agentId : record.agentId,
      revision: record.contract.binding.revision, code_version: record.contract.binding.codeVersion,
      repository_path: record.repositoryPath, draft_id: draft?.id ?? null, sequence: draft?.sequence ?? 0,
      status: draft?.status ?? "unstarted", current_phase: draft?.phase ?? null,
      phases: Object.entries(definition.phases).map(([id]) => ({ id, status: draft?.completedPhases.includes(id) ? "completed" : draft?.phase === id ? "current" : "upcoming" })),
      sources: record.contract.sources.map(({ sourceRef, ...source }) => ({ ...source, source_ref: sourceRef })),
      questions: (draft?.runtimeInputs ?? []).map(input => ({ id: input.id, title: input.title, question: input.question, why: input.why, recommendation: input.recommendation, active: input.active, phase: input.phase,
        answer: input.answer ? { text: input.answer.text, user_id: input.answer.userId, sequence: input.answer.sequence } : null })),
      artifacts: (draft?.artifacts ?? []).map(item => ({ ref: item.ref, key: item.key, title: artifactBlock(definition, item.ref).title, content: item.content })),
      result: conclusion ?? null,
    };
  }

  private async continuations() {
    const rows = this.db.prepare(`SELECT c.payload FROM engineering_contract c
      WHERE c.revision = (SELECT MAX(latest.revision) FROM engineering_contract latest WHERE latest.workspace_id = c.workspace_id AND latest.issue_id = c.issue_id)`).all();
    const pending = [];
    for (const row of rows) {
      const record = recordSchema.parse(JSON.parse(String(row.payload)));
      if (!record.autoContinue) continue;
      const development = Boolean(record.development && !record.development.handoff);
      const draftId = development ? record.development!.draftId : record.draftId;
      const draft = await this.drafts.read(draftId);
      const reason = !draft && record.development?.handoff ? "development_handoff" :
        draft?.status === "waiting_for_answers" && draft.runtimeInputs.some(input => input.active) && draft.runtimeInputs.every(input => !input.active || input.answer !== null) ? "human_answers" : null;
      if (!reason) continue;
      const sequence = draft?.sequence ?? 0;
      const hash = createHash("sha256").update(`multica:engineering:continuation:${draftId}:${sequence}`).digest("hex");
      const taskId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      pending.push({ workspace_id: record.workspaceId, issue_id: record.issueId, agent_id: development ? record.development!.agentId : record.agentId,
        user_id: record.createdBy, task_id: taskId, expected_revision: record.contract.binding.revision, expected_sequence: sequence, reason });
    }
    return pending;
  }

  async invoke(input: ApplicationRequest) {
    const request = applicationRequestSchema.parse(input);
    const { actor, action } = request;
    if (actor.kind === "coordinator") {
      if (action !== "continuations") throw new Error("Coordinator credentials cannot edit engineering state");
      return this.continuations();
    }
    if (action === "continuations") throw new Error("Only the host coordinator can list continuations");
    let record = this.current(actor.workspaceId, actor.issueId);
    if (action === "overview" || action === "prepare-run") {
      if (actor.kind !== "human") throw new Error("A human actor is required for engineering controls");
      if (action === "overview") return this.overview(record);
      if (!record) throw new Error("Configure engineering before starting a run");
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
        if (repositoryCommonDirectory(root) !== repositoryCommonDirectory(record.repositoryPath) || resource.mode === "in_place" && root !== record.repositoryPath) throw new Error("The project directory does not match the registered engineering repository");
      }
      return { agent_id: state.agent_id, revision: state.revision, sequence: state.sequence };
    }
    if (action === "completion") {
      if (actor.kind !== "host") throw new Error("Only the host can authorize issue completion");
      if (!record) return { configured: false, allowed: true };
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
    if (action === "selection") return {
      configured: actor.kind === "task" && (record?.development && !record.development.handoff ? record.development.agentId === actor.agentId : record?.agentId === actor.agentId),
      chain: record?.development && !record.development.handoff ? "development" : "verification",
      ...(record ? { repository_path: record.repositoryPath, code_version: this.selectionCommit(record) } : {}),
    };
    if (action === "configure") {
      if (actor.kind !== "human") throw new Error("Only a human can freeze verification contracts");
      const config = configuration.parse(request.payload);
      if (config.developer_agent_id === config.agent_id) throw new Error("Development and independent verification require different agents");
      if (config.developer_agent_id && !config.implementation_guidance) throw new Error("Development requires frozen implementation guidance");
      if (config.developer_agent_id && !this.developmentSource) throw new Error("Development definition is unavailable");
      if (config.expected_revision !== (record?.contract.binding.revision ?? 0)) throw new DraftConflictError("Contract revision changed; reload before configuring");
      const previousDraft = record && await this.drafts.read(record.development && !record.development.handoff ? record.development.draftId : record.draftId);
      if (previousDraft && previousDraft.status !== "completed" && previousDraft.status !== "abandoned") throw new Error("Abandon the active draft before replacing its contract");
      const code = snapshot(config.repository_path);
      const revision = config.expected_revision + 1;
      const sources = config.sources;
      const contractVersion = createHash("sha256").update(JSON.stringify({ workspaceId: actor.workspaceId, issueId: actor.issueId, revision, sources })).digest("hex");
      const contract = verificationContractSchema.parse({
        binding: { workspaceId: actor.workspaceId, issueId: actor.issueId, revision, contractVersion, codeVersion: code.codeVersion }, sources,
      });
      record = recordSchema.parse({ workspaceId: actor.workspaceId, issueId: actor.issueId, agentId: config.agent_id,
        repositoryPath: code.repositoryPath, draftId: randomUUID(), createdBy: actor.userId, autoContinue: config.auto_continue,
        definitionSource: this.definitionSource, contract,
        ...(config.developer_agent_id ? { development: { agentId: config.developer_agent_id, draftId: randomUUID(), definitionSource: this.developmentSource, baseCodeVersion: code.codeVersion, implementationGuidance: config.implementation_guidance, handoff: false } } : {}),
      });
      const inserted = this.db.prepare("INSERT INTO engineering_contract (workspace_id, issue_id, revision, payload) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .run(actor.workspaceId, actor.issueId, revision, JSON.stringify(record));
      if (inserted.changes !== 1) throw new DraftConflictError("Contract revision changed");
      return this.view(record, undefined, Boolean(record.development));
    }
    if (!record) throw new Error("No verification contract is configured for this issue");
    if (action === "bind") {
      if (actor.kind !== "daemon") throw new Error("Only the runtime can bind execution repositories");
      const development = Boolean(record.development && !record.development.handoff && actor.agentId === record.development.agentId);
      if (!development && actor.agentId === record.agentId && record.development && !record.development.handoff) throw new Error("Development has not handed off a verified commit yet");
      if (!development && actor.agentId !== record.agentId) throw new Error("Run agent does not own this verification role");
      const payload = z.strictObject({ work_dir: text, mode: z.enum(["in_place", "worktree"]), overlays: z.array(z.strictObject({ path: text, hash: z.string().regex(/^[a-f0-9]{64}$/) })).max(5000) }).parse(request.payload);
      const code = snapshot(payload.work_dir, false);
      if (repositoryCommonDirectory(code.repositoryPath) !== repositoryCommonDirectory(record.repositoryPath)) throw new Error("Execution repository is not a worktree of the registered repository");
      if (payload.mode === "in_place" && code.repositoryPath !== record.repositoryPath) throw new Error("In-place execution must use the registered repository");
      const overlays = captureRepositoryOverlays(code.repositoryPath, payload.overlays, !development);
      if (development) git(code.repositoryPath, ["merge-base", "--is-ancestor", record.development!.baseCodeVersion, code.codeVersion]);
      else if (code.codeVersion !== record.contract.binding.codeVersion) throw new Error("Verification execution is not at the frozen delivery commit");
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
      if (!draft) draft = await engine.create({ id: draftId, chain: parseCommandChainDefinition(development ? record.development!.definitionSource : record.definitionSource, development ? developmentProfile : profile), binding: development ? this.devContract(record).binding : record.contract.binding, attemptId: actor.attemptId });
      else if (draft.status === "abandoned") throw new Error("Verification draft is abandoned; freeze a new revision");
      else if (draft.status !== "completed" && draft.attemptId !== actor.attemptId) draft = await engine.resume(draft.id, draft.sequence, actor.attemptId);
    } else if (action !== "read") {
      if (!draft) throw new Error("Start the verification draft before editing or answering");
      if (action === "command" && actor.kind === "task") {
        const command = z.strictObject({ expected_sequence: sequence, command: chainCommandSchema }).parse(request.payload);
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
    return actor.kind === "human" ? { ...view, developmentConclusion: record.development?.conclusion ?? null } : view;
  }

  close() { this.drafts.close(); this.db.close(); }
}
