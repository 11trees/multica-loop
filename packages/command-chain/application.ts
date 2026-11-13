import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { parseCommandChainDefinition, type CommandChainProfile } from "./definition";
import { CommandChainEngine, DraftConflictError, chainCommandSchema, type ChainDraft } from "./runtime";
import { SqliteDraftStore } from "./sqlite-store";
import { compileVerificationConclusion, createVerificationHandlers, verificationContractSchema } from "./verification";
import { commandReceiptSchema, createDevelopmentHandlers, compileDevelopmentConclusion, type CommandReceipt } from "./development";
import { git, repositorySnapshot as snapshot, repositoryFingerprint } from "./repository";

const text = z.string().trim().min(1);
const sequence = z.number().int().nonnegative();
const scope = { workspaceId: z.uuid(), issueId: z.uuid() };
const human = z.strictObject({ kind: z.literal("human"), userId: z.uuid(), ...scope });
const task = z.strictObject({ kind: z.literal("task"), agentId: z.uuid(), attemptId: text, ...scope });
const daemon = task.extend({ kind: z.literal("daemon") });
const host = z.strictObject({ kind: z.literal("host"), ...scope });
const actor = z.discriminatedUnion("kind", [human, task, daemon, host]);
export const applicationRequestSchema = z.strictObject({
  actor,
  action: z.enum(["configure", "read", "start", "command", "answer", "abandon", "selection", "receipt", "completion"]),
  payload: z.unknown().optional(),
});
export type ApplicationRequest = z.infer<typeof applicationRequestSchema>;
const configuration = z.strictObject({
  expected_revision: sequence,
  agent_id: z.uuid(), repository_path: text,
  developer_agent_id: z.uuid().optional(),
  implementation_guidance: text.optional(),
  sources: verificationContractSchema.shape.sources,
});
const recordSchema = z.strictObject({
  ...scope, agentId: z.uuid(), repositoryPath: text, draftId: z.uuid(),
  createdBy: z.uuid(), definitionSource: text,
  contract: verificationContractSchema,
  development: z.strictObject({ agentId: z.uuid(), draftId: z.uuid(), definitionSource: text, baseCodeVersion: text, implementationGuidance: text, handoff: z.boolean(), conclusion: z.json().optional() }).optional(),
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
  }

  private current(workspaceId: string, issueId: string): Record | undefined {
    const row = this.db.prepare("SELECT payload FROM engineering_contract WHERE workspace_id = ? AND issue_id = ? ORDER BY revision DESC LIMIT 1").get(workspaceId, issueId);
    return row ? recordSchema.parse(JSON.parse(String(row.payload))) : undefined;
  }

  private devContract(record: Record) {
    return { ...record.contract, implementationGuidance: record.development!.implementationGuidance, binding: { ...record.contract.binding, codeVersion: record.development!.baseCodeVersion } };
  }

  private runtime(record: Record) {
    return {
      receipts: (): CommandReceipt[] => this.db.prepare("SELECT payload FROM engineering_receipt WHERE draft_id = ?").all(record.development!.draftId).map(row => commandReceiptSchema.parse(JSON.parse(String(row.payload)))),
      fingerprint: () => repositoryFingerprint(record.repositoryPath),
    };
  }

  private engine(record: Record, development = false) {
    return new CommandChainEngine(this.drafts, development ? createDevelopmentHandlers(this.devContract(record), this.runtime(record)) : createVerificationHandlers(record.contract));
  }

  private view(record: Record, draft: ChainDraft | undefined, development = false) {
    const phase = draft?.phase ? draft.definition.phases[draft.phase] : undefined;
    return {
      chain: development ? "development" : "verification",
      agentId: development ? record.development!.agentId : record.agentId, repositoryPath: record.repositoryPath, contract: development ? this.devContract(record) : record.contract,
      draft: draft ?? null,
      instructions: phase?.type === "builtin" ? instructions[phase.builtin] : phase?.instructions,
      receipts: development ? this.runtime(record).receipts() : [],
      conclusion: draft?.status === "completed" ? development ? record.development!.conclusion ?? null : compileVerificationConclusion(draft, record.contract) : null,
    };
  }

  async invoke(input: ApplicationRequest) {
    const request = applicationRequestSchema.parse(input);
    const { actor, action } = request;
    let record = this.current(actor.workspaceId, actor.issueId);
    if (action === "completion") {
      if (actor.kind !== "host") throw new Error("Only the host can authorize issue completion");
      if (!record) return { configured: false, allowed: true };
      if (record.development && !record.development.handoff) throw new DraftConflictError("Development has not handed off its committed result");
      const draft = await this.drafts.read(record.draftId);
      if (!draft || draft.status !== "completed") throw new DraftConflictError("Complete independent verification before marking this issue done");
      const conclusion = compileVerificationConclusion(draft, record.contract);
      if (conclusion.verdict !== "passed") throw new DraftConflictError(`Independent verification failed; return to ${conclusion.rewindTo}`);
      const code = snapshot(record.repositoryPath);
      if (code.codeVersion !== record.contract.binding.codeVersion) throw new DraftConflictError("Repository commit changed after verification; freeze and verify a new revision");
      return { configured: true, allowed: true, binding: conclusion.binding };
    }
    if (actor.kind === "host") throw new Error("Host completion credentials cannot edit chain state");
    if (action === "selection") return {
      configured: actor.kind === "task" && (record?.development && !record.development.handoff ? record.development.agentId === actor.agentId : record?.agentId === actor.agentId),
      chain: record?.development && !record.development.handoff ? "development" : "verification",
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
        repositoryPath: code.repositoryPath, draftId: randomUUID(), createdBy: actor.userId,
        definitionSource: this.definitionSource, contract,
        ...(config.developer_agent_id ? { development: { agentId: config.developer_agent_id, draftId: randomUUID(), definitionSource: this.developmentSource, baseCodeVersion: code.codeVersion, implementationGuidance: config.implementation_guidance, handoff: false } } : {}),
      });
      const inserted = this.db.prepare("INSERT INTO engineering_contract (workspace_id, issue_id, revision, payload) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .run(actor.workspaceId, actor.issueId, revision, JSON.stringify(record));
      if (inserted.changes !== 1) throw new DraftConflictError("Contract revision changed");
      return this.view(record, undefined, Boolean(record.development));
    }
    if (!record) throw new Error("No verification contract is configured for this issue");
    if (action === "receipt") {
      if (actor.kind !== "daemon") throw new Error("Only the runtime can capture command receipts");
      if (!record.development || actor.agentId !== record.development.agentId || record.development.handoff) return { ignored: true };
      const payload = z.strictObject({ id: text, sequence, command: text, cwd: text, status: text, exit_code: z.number().int().nullable() }).parse(request.payload);
      if (payload.command.toLowerCase().includes("multica") && payload.command.includes(" engineering ")) return { ignored: true };
      if (snapshot(payload.cwd, false).repositoryPath !== record.repositoryPath) throw new Error("Command receipt belongs to another repository");
      const id = `${actor.attemptId}:${payload.id}`;
      const previous = this.runtime(record).receipts().find(item => item.id === id);
      if (previous) {
        if (previous.sequence !== payload.sequence || previous.command !== payload.command || previous.cwd !== payload.cwd || previous.status !== payload.status || previous.exitCode !== payload.exit_code) throw new DraftConflictError("Receipt identity cannot be rewritten");
        return { captured: previous.id };
      }
      const receipt = commandReceiptSchema.parse({ id, attemptId: actor.attemptId, sequence: payload.sequence, command: payload.command,
        commandHash: createHash("sha256").update(JSON.stringify([payload.command, payload.cwd])).digest("hex"), cwd: payload.cwd,
        status: payload.status, exitCode: payload.exit_code, fingerprint: repositoryFingerprint(record.repositoryPath) });
      this.db.prepare("INSERT INTO engineering_receipt (draft_id, receipt_id, payload) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(record.development.draftId, receipt.id, JSON.stringify(receipt));
      return { captured: receipt.id };
    }
    if (actor.kind === "daemon") throw new Error("Runtime credentials cannot edit chain state");
    const development = Boolean(record.development && (actor.kind === "task" ? actor.agentId === record.development.agentId : !record.development.handoff));
    if (actor.kind === "task" && !development && actor.agentId !== record.agentId) throw new Error("Run agent does not own this verification role");
    if (actor.kind === "task" && !development && record.development && !record.development.handoff) throw new Error("Development has not handed off a verified commit yet");
    if (actor.kind === "human" && action !== "read" && action !== "answer" && action !== "abandon") throw new Error("This operation requires the configured run credential");
    if (actor.kind === "task" && action !== "read" && action !== "start" && action !== "command") throw new Error("This operation requires a human actor");
    const engine = this.engine(record, development);
    const draftId = development ? record.development!.draftId : record.draftId;
    let draft = await this.drafts.read(draftId);
    if (actor.kind === "task") {
      const code = snapshot(record.repositoryPath, !development);
      if (development) git(record.repositoryPath, ["merge-base", "--is-ancestor", record.development!.baseCodeVersion, code.codeVersion]);
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
        if (development && command.command.type === "phase.complete" && (draft.phase === "commit" || draft.phase === "finalize")) snapshot(record.repositoryPath);
        draft = await engine.execute(draft.id, { attemptId: actor.attemptId, expectedSequence: command.expected_sequence }, command.command);
      } else if (action === "answer" && actor.kind === "human") {
        const answer = z.strictObject({ expected_sequence: sequence, request_id: text, answer: text }).parse(request.payload);
        draft = await engine.answerRuntimeInput(draft.id, { expectedSequence: answer.expected_sequence, requestId: answer.request_id, answer: answer.answer, userId: actor.userId });
      } else if (action === "abandon" && actor.kind === "human") {
        const abandon = z.strictObject({ expected_sequence: sequence, reason: text }).parse(request.payload);
        draft = await engine.abandon(draft.id, abandon.expected_sequence, abandon.reason, actor.userId);
      }
    }
    if (development && draft?.status === "completed" && !record.development!.handoff) {
      const code = snapshot(record.repositoryPath);
      const conclusion = compileDevelopmentConclusion(draft, this.devContract(record), this.runtime(record));
      record.development!.conclusion = JSON.parse(JSON.stringify({ ...conclusion, commit: code.codeVersion }));
      record.development!.handoff = true;
      record.contract.binding.codeVersion = code.codeVersion;
      this.db.prepare("UPDATE engineering_contract SET payload = ? WHERE workspace_id = ? AND issue_id = ? AND revision = ?")
        .run(JSON.stringify(record), actor.workspaceId, actor.issueId, record.contract.binding.revision);
    }
    const view = this.view(record, draft, development);
    return actor.kind === "human" ? { ...view, developmentConclusion: record.development?.conclusion ?? null } : view;
  }

  close() { this.drafts.close(); this.db.close(); }
}
