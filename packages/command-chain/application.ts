import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { parseCommandChainDefinition, type CommandChainProfile } from "./definition";
import { CommandChainEngine, DraftConflictError, chainCommandSchema, type ChainDraft } from "./runtime";
import { SqliteDraftStore } from "./sqlite-store";
import { compileVerificationConclusion, createVerificationHandlers, verificationContractSchema } from "./verification";

const text = z.string().trim().min(1);
const sequence = z.number().int().nonnegative();
const scope = { workspaceId: z.uuid(), issueId: z.uuid() };
const human = z.strictObject({ kind: z.literal("human"), userId: z.uuid(), ...scope });
const task = z.strictObject({ kind: z.literal("task"), agentId: z.uuid(), attemptId: text, ...scope });
const actor = z.discriminatedUnion("kind", [human, task]);
export const applicationRequestSchema = z.strictObject({
  actor,
  action: z.enum(["configure", "read", "start", "command", "answer", "abandon", "selection"]),
  payload: z.unknown().optional(),
});
export type ApplicationRequest = z.infer<typeof applicationRequestSchema>;
const configuration = z.strictObject({
  expected_revision: sequence,
  agent_id: z.uuid(), repository_path: text,
  sources: verificationContractSchema.shape.sources,
});
const recordSchema = z.strictObject({
  ...scope, agentId: z.uuid(), repositoryPath: text, draftId: z.uuid(),
  createdBy: z.uuid(), definitionSource: text,
  contract: verificationContractSchema,
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
  "verification-inputs": "Read the frozen sources and their oracles. Do not replace them with development claims.",
  "verification-plan": "Plan scenarios against every frozen source before recording actual results. Cover at least one acceptance through frontend. Request runtime input if blocked.",
  "verification-execution": "Execute the frozen scenarios. Record independent observations under matching scenario keys. Existing scenarios are immutable; new risks use new keys. Request runtime input and suspend when blocked.",
  "verification-finalize": "Recheck the frozen inputs, observations, and evidence review. A failed implementation can still produce a completed verification report.",
};

function git(path: string, args: string[]): string {
  return execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", path, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function snapshot(path: string) {
  const repositoryPath = realpathSync(git(realpathSync(path), ["rev-parse", "--show-toplevel"]));
  if (git(repositoryPath, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("Verification repository has uncommitted changes; commit or isolate them before freezing/testing");
  return { repositoryPath, codeVersion: git(repositoryPath, ["rev-parse", "HEAD"]) };
}

/** Invoked only over the authenticated Go host's private stdin/stdout boundary. */
export class EngineeringApplication {
  private readonly db: DatabaseSync;
  private readonly drafts: SqliteDraftStore;

  constructor(database: string, private readonly definitionSource: string) {
    parseCommandChainDefinition(definitionSource, profile);
    this.db = new DatabaseSync(database);
    this.db.exec(`CREATE TABLE IF NOT EXISTS engineering_contract (
      workspace_id TEXT NOT NULL, issue_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (workspace_id, issue_id, revision)
    )`);
    this.drafts = new SqliteDraftStore(database);
  }

  private current(workspaceId: string, issueId: string): Record | undefined {
    const row = this.db.prepare("SELECT payload FROM engineering_contract WHERE workspace_id = ? AND issue_id = ? ORDER BY revision DESC LIMIT 1").get(workspaceId, issueId);
    return row ? recordSchema.parse(JSON.parse(String(row.payload))) : undefined;
  }

  private engine(record: Record) {
    return new CommandChainEngine(this.drafts, createVerificationHandlers(record.contract));
  }

  private view(record: Record, draft: ChainDraft | undefined) {
    const phase = draft?.phase ? draft.definition.phases[draft.phase] : undefined;
    return {
      agentId: record.agentId, repositoryPath: record.repositoryPath, contract: record.contract,
      draft: draft ?? null,
      instructions: phase?.type === "builtin" ? instructions[phase.builtin] : phase?.instructions,
      conclusion: draft?.status === "completed" ? compileVerificationConclusion(draft, record.contract) : null,
    };
  }

  async invoke(input: ApplicationRequest) {
    const request = applicationRequestSchema.parse(input);
    const { actor, action } = request;
    let record = this.current(actor.workspaceId, actor.issueId);
    if (action === "selection") return {
      configured: actor.kind === "task" && record?.agentId === actor.agentId,
    };
    if (action === "configure") {
      if (actor.kind !== "human") throw new Error("Only a human can freeze verification contracts");
      const config = configuration.parse(request.payload);
      if (config.expected_revision !== (record?.contract.binding.revision ?? 0)) throw new DraftConflictError("Contract revision changed; reload before configuring");
      const previousDraft = record && await this.drafts.read(record.draftId);
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
        definitionSource: this.definitionSource, contract });
      const inserted = this.db.prepare("INSERT INTO engineering_contract (workspace_id, issue_id, revision, payload) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .run(actor.workspaceId, actor.issueId, revision, JSON.stringify(record));
      if (inserted.changes !== 1) throw new DraftConflictError("Contract revision changed");
      return this.view(record, undefined);
    }
    if (!record) throw new Error("No verification contract is configured for this issue");
    if (actor.kind === "task" && actor.agentId !== record.agentId) throw new Error("Run agent does not own this verification role");
    if (actor.kind === "human" && action !== "read" && action !== "answer" && action !== "abandon") throw new Error("This operation requires the configured run credential");
    if (actor.kind === "task" && action !== "read" && action !== "start" && action !== "command") throw new Error("This operation requires a human actor");
    const engine = this.engine(record);
    let draft = await this.drafts.read(record.draftId);
    if (actor.kind === "task") {
      const code = snapshot(record.repositoryPath);
      if (code.codeVersion !== record.contract.binding.codeVersion) throw new Error("Repository commit changed; freeze a new verification revision");
    }
    if (action === "start" && actor.kind === "task") {
      if (!draft) draft = await engine.create({ id: record.draftId, chain: parseCommandChainDefinition(record.definitionSource, profile), binding: record.contract.binding, attemptId: actor.attemptId });
      else if (draft.status === "abandoned") throw new Error("Verification draft is abandoned; freeze a new revision");
      else if (draft.status !== "completed" && draft.attemptId !== actor.attemptId) draft = await engine.resume(draft.id, draft.sequence, actor.attemptId);
    } else if (action !== "read") {
      if (!draft) throw new Error("Start the verification draft before editing or answering");
      if (action === "command" && actor.kind === "task") {
        const command = z.strictObject({ expected_sequence: sequence, command: chainCommandSchema }).parse(request.payload);
        draft = await engine.execute(draft.id, { attemptId: actor.attemptId, expectedSequence: command.expected_sequence }, command.command);
      } else if (action === "answer" && actor.kind === "human") {
        const answer = z.strictObject({ expected_sequence: sequence, request_id: text, answer: text }).parse(request.payload);
        draft = await engine.answerRuntimeInput(draft.id, { expectedSequence: answer.expected_sequence, requestId: answer.request_id, answer: answer.answer, userId: actor.userId });
      } else if (action === "abandon" && actor.kind === "human") {
        const abandon = z.strictObject({ expected_sequence: sequence, reason: text }).parse(request.payload);
        draft = await engine.abandon(draft.id, abandon.expected_sequence, abandon.reason, actor.userId);
      }
    }
    return this.view(record, draft);
  }

  close() { this.drafts.close(); this.db.close(); }
}
