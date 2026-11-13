import { z } from "zod";
import type { LoadedCommandChain } from "./definition";
import {
  CommandChainEngine, DraftConflictError, draftSchema,
  type ChainBinding, type ChainCommand, type ChainDraft,
} from "./runtime";

const contextSchema = z.object({
  api_version: z.literal(1),
  workspace_id: z.uuid(), issue_id: z.uuid(), task_id: z.uuid(), agent_id: z.uuid(), runtime_id: z.uuid(),
  attempt: z.number().int().nonnegative(),
  claim_id: z.string().regex(/^[1-9]\d*$/),
  attempt_id: z.string().min(1),
  status: z.literal("running"),
}).refine(value => value.attempt_id === `${value.task_id}:${value.claim_id}`, { message: "Invalid task claim identity" });

export type MulticaRunContext = {
  workspaceId: string; issueId: string; taskId: string; agentId: string; runtimeId: string;
  attempt: number; claimId: string; attemptId: string;
};

/** Uses the run's injected task token, not user/PAT credentials or identity headers. */
export class MulticaRunClient {
  private readonly endpoint: URL;

  constructor(private readonly options: { baseUrl: string; taskToken: string; fetch?: typeof fetch }) {
    this.endpoint = new URL("/api/engineering/run", options.baseUrl);
    if (!options.taskToken.startsWith("mat_")) throw new Error("A Multica task token is required");
    if (!["http:", "https:"].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password) throw new Error("Invalid Multica API origin");
  }

  async context(): Promise<MulticaRunContext> {
    const response = await (this.options.fetch ?? globalThis.fetch)(this.endpoint, {
      headers: { Authorization: `Bearer ${this.options.taskToken}` },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Multica rejected the run context (HTTP ${response.status})`);
    const value = contextSchema.parse(await response.json());
    return {
      workspaceId: value.workspace_id, issueId: value.issue_id, taskId: value.task_id,
      agentId: value.agent_id, runtimeId: value.runtime_id, attempt: value.attempt,
      claimId: value.claim_id, attemptId: value.attempt_id,
    };
  }
}

/** Host configuration, including role assignment and contract/code lookup, is not agent input. */
export class MulticaChainBridge {
  constructor(private readonly options: {
    client: MulticaRunClient;
    engine: CommandChainEngine;
    agentId: string;
    chain: LoadedCommandChain;
    resolveBinding: (run: MulticaRunContext) => ChainBinding | Promise<ChainBinding>;
  }) {}

  private async authorize(draft?: ChainDraft) {
    const run = await this.options.client.context();
    if (run.agentId !== this.options.agentId) throw new Error("Run agent does not own this command-chain role");
    const binding = draftSchema.shape.binding.parse(await this.options.resolveBinding(run));
    if (binding.workspaceId !== run.workspaceId || binding.issueId !== run.issueId) throw new Error("Contract does not belong to the authenticated issue/workspace");
    if (draft) {
      if (draft.definition.id !== this.options.chain.definition.id || draft.definition.agent !== this.options.chain.definition.agent) throw new Error("Draft belongs to another command-chain role");
      for (const key of Object.keys(binding) as (keyof ChainBinding)[]) {
        if (binding[key] !== draft.binding[key]) throw new DraftConflictError(`Draft binding ${key} changed; establish the current delivery revision`);
      }
    }
    return { run, binding };
  }

  async create(id: string, inputs?: Record<string, string>): Promise<ChainDraft> {
    const { run, binding } = await this.authorize();
    return this.options.engine.create({ id, chain: this.options.chain, binding, attemptId: run.attemptId, inputs });
  }

  async read(id: string): Promise<ChainDraft> {
    const draft = await this.options.engine.read(id);
    await this.authorize(draft);
    return draft;
  }

  async execute(id: string, expectedSequence: number, command: ChainCommand): Promise<ChainDraft> {
    const draft = await this.options.engine.read(id);
    const { run } = await this.authorize(draft);
    return this.options.engine.execute(id, { attemptId: run.attemptId, expectedSequence }, command);
  }

  async resume(id: string, expectedSequence: number): Promise<ChainDraft> {
    const draft = await this.options.engine.read(id);
    const { run } = await this.authorize(draft);
    return this.options.engine.resume(id, expectedSequence, run.attemptId);
  }
}
