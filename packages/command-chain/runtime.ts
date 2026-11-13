import { z } from "zod";
import { artifactBlock, validateArtifactContent } from "./artifacts";
import { commandChainDefinitionSchema, type LoadedCommandChain } from "./definition";

const text = z.string().trim().min(1);
const sequence = z.number().int().nonnegative();
const artifactItem = z.strictObject({
  ref: text,
  key: z.string(),
  content: text,
  phase: text.nullable(),
  attemptId: text,
});
const event = z.strictObject({
  sequence,
  attemptId: text,
  command: text,
  phase: text.nullable(),
  reason: text.optional(),
  userId: text.optional(),
});
const writeRule = z.strictObject({ ref: text, mode: z.enum(["append-only", "sealed"]), phase: text });
const runtimeInputFields = {
  key: text.max(120), title: text.max(200), question: text.max(4000),
  why: text.max(1000), recommendation: text.max(2000),
};
const runtimeInputSchema = z.strictObject({
  ...runtimeInputFields,
  id: text,
  phase: text,
  attemptId: text,
  active: z.boolean(),
  answer: z.strictObject({ text: text.max(20000), userId: text, sequence }).nullable(),
});

export const draftSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: text,
  binding: z.strictObject({
    workspaceId: text,
    issueId: text,
    revision: z.number().int().positive(),
    contractVersion: text,
    codeVersion: text,
  }),
  definition: commandChainDefinitionSchema,
  sequence,
  attemptId: text,
  status: z.enum(["editing", "waiting_for_answers", "completed"]),
  phase: text.nullable(),
  inputs: z.record(text, text),
  artifacts: z.array(artifactItem),
  frozen: z.array(z.strictObject({ ref: text, key: z.string(), phase: text })),
  writeRules: z.array(writeRule),
  runtimeInputs: z.array(runtimeInputSchema),
  completedPhases: z.array(text),
  events: z.array(event),
});

export type ChainDraft = z.infer<typeof draftSchema>;
export type ChainBinding = ChainDraft["binding"];
export type ArtifactItem = z.infer<typeof artifactItem>;
export type ArtifactWrite = { ref: string; key?: string; content: string };
export type MutationContext = { attemptId: string; expectedSequence: number };
export type RuntimeInput = z.infer<typeof runtimeInputSchema>;

export function pendingRuntimeInputs(draft: Readonly<ChainDraft>): RuntimeInput[] {
  return draft.runtimeInputs.filter(input => input.active && input.answer === null);
}

export class DraftConflictError extends Error {}
export class PhaseValidationError extends Error {
  constructor(public readonly errors: readonly string[]) {
    super(errors.join("\n"));
  }
}

/** Implementations must atomically create and compare-and-swap the whole draft. */
export interface DraftStore {
  read(id: string): Promise<ChainDraft | undefined>;
  create(draft: ChainDraft): Promise<void>;
  save(draft: ChainDraft, expectedSequence: number): Promise<void>;
}

export type BuiltinResult = {
  errors: readonly string[];
  artifacts?: readonly ArtifactWrite[];
  freeze?: readonly string[];
  writeRules?: readonly { ref: string; mode: "append-only" | "sealed" }[];
};
// Host-owned validators are read-only and must not perform delivery side effects.
// Their output and phase completion become durable together in one store write.
export type BuiltinHandler = {
  (draft: Readonly<ChainDraft>): BuiltinResult | Promise<BuiltinResult>;
  readonly runtimeInputs?: boolean;
};
export type BuiltinHandlers = Readonly<Record<string, BuiltinHandler>>;

const commandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("artifact.put"), ref: text, key: text.max(120).optional(), content: text }),
  z.strictObject({ type: z.literal("artifact.remove"), ref: text, key: text.max(120).optional() }),
  z.strictObject({ type: z.literal("metadata.set"), input: text, value: text }),
  z.strictObject({ type: z.literal("runtime-input.put"), ...runtimeInputFields }),
  z.strictObject({ type: z.literal("runtime-input.remove"), key: text.max(120) }),
  z.strictObject({ type: z.literal("phase.complete"), confirmation: text.optional() }),
  z.strictObject({ type: z.literal("phase.rewind"), to: text, reason: text.max(4000) }),
]);
export type ChainCommand = z.infer<typeof commandSchema>;

function itemKey(draft: ChainDraft, ref: string, key?: string): string {
  const block = artifactBlock(draft.definition, ref);
  if (block.cardinality === "many") {
    if (!key?.trim() || key.length > 120) throw new Error(`Artifact ${ref} requires a stable item key`);
    return key;
  }
  if (key !== undefined) throw new Error(`Singleton artifact ${ref} does not accept an item key`);
  return "";
}

function putArtifact(draft: ChainDraft, write: ArtifactWrite, phase: string | null): void {
  const key = itemKey(draft, write.ref, write.key);
  const index = draft.artifacts.findIndex(item => item.ref === write.ref && item.key === key);
  if (draft.frozen.some(item => item.ref === write.ref && item.key === key)) {
    throw new Error(`Artifact ${write.ref}/${key} is frozen; rewind before changing it`);
  }
  if (draft.writeRules.some(rule => rule.ref === write.ref && (rule.mode === "sealed" || index >= 0))) {
    throw new Error(`Artifact ${write.ref} is sealed or append-only; rewind before changing it`);
  }
  const content = validateArtifactContent(artifactBlock(draft.definition, write.ref), write.content);
  const item: ArtifactItem = { ref: write.ref, key, content, phase, attemptId: draft.attemptId };
  if (index < 0) draft.artifacts.push(item);
  else draft.artifacts[index] = item;
}

function requiredArtifactErrors(draft: ChainDraft, refs: readonly string[]): string[] {
  return refs.filter(ref => artifactBlock(draft.definition, ref).required && !draft.artifacts.some(item => item.ref === ref))
    .map(ref => `Required artifact ${ref} is missing`);
}

function currentPhase(draft: ChainDraft) {
  const phase = draft.phase && Object.hasOwn(draft.definition.phases, draft.phase) ? draft.definition.phases[draft.phase] : undefined;
  if (!phase || draft.status !== "editing") throw new Error("Draft has no editable phase");
  return phase;
}

function recordEvent(draft: ChainDraft, command: string, reason?: string, userId?: string): void {
  draft.sequence += 1;
  draft.events.push({ sequence: draft.sequence, attemptId: draft.attemptId, command, phase: draft.phase, ...(reason ? { reason } : {}), ...(userId ? { userId } : {}) });
}

/** Authorization and trusted Multica run lookup belong to the caller, not tool arguments. */
export class CommandChainEngine {
  constructor(private readonly store: DraftStore, private readonly builtins: BuiltinHandlers = {}) {}

  async create(input: {
    id: string;
    chain: LoadedCommandChain;
    binding: ChainBinding;
    attemptId: string;
    inputs?: Record<string, string>;
    readonlyArtifacts?: readonly ArtifactWrite[];
  }): Promise<ChainDraft> {
    const order = Object.keys(input.chain.definition.phases);
    if (!order.length || JSON.stringify(order) !== JSON.stringify(input.chain.phaseOrder)) throw new Error("Invalid phase order");
    for (const key of Object.keys(input.inputs ?? {})) {
      if (!Object.hasOwn(input.chain.definition.inputs, key)) throw new Error(`Unknown input ${key}`);
    }
    const inputs = Object.fromEntries(Object.entries(input.chain.definition.inputs).flatMap(([key, value]) => {
      const supplied = input.inputs?.[key] ?? value.default;
      return supplied === undefined ? [] : [[key, supplied]];
    }));
    const draft = draftSchema.parse({
      schemaVersion: 1, id: input.id, binding: input.binding, definition: input.chain.definition,
      sequence: 0, attemptId: input.attemptId, status: "editing", phase: order[0],
      inputs, artifacts: [], frozen: [], writeRules: [], runtimeInputs: [], completedPhases: [], events: [],
    });
    for (const write of input.readonlyArtifacts ?? []) {
      if (artifactBlock(draft.definition, write.ref).writable) throw new Error(`Initial artifact ${write.ref} must be readonly`);
      putArtifact(draft, write, null);
    }
    await this.store.create(draft);
    return structuredClone(draft);
  }

  async read(id: string): Promise<ChainDraft> {
    const value = await this.store.read(id);
    if (!value) throw new Error(`Draft ${id} does not exist`);
    return draftSchema.parse(value);
  }

  /** Host-only checkpoint takeover; stale run attempts cannot continue writing. */
  async resume(id: string, expectedSequence: number, attemptId: string): Promise<ChainDraft> {
    const draft = await this.read(id);
    if (draft.sequence !== expectedSequence) throw new DraftConflictError("Draft changed; reload before resuming");
    if (draft.status === "waiting_for_answers") {
      if (pendingRuntimeInputs(draft).length) throw new Error("Runtime inputs still require human answers");
      draft.status = "editing";
    }
    currentPhase(draft);
    const nextAttemptId = text.parse(attemptId);
    if (draft.attemptId === nextAttemptId) throw new Error("Resume requires a new run attempt");
    draft.attemptId = nextAttemptId;
    recordEvent(draft, "attempt.resume");
    await this.store.save(draft, expectedSequence);
    return structuredClone(draft);
  }

  /** Host-only: the caller must authenticate a human and derive their user ID. */
  async answerRuntimeInput(id: string, input: {
    expectedSequence: number; requestId: string; answer: string; userId: string;
  }): Promise<ChainDraft> {
    const draft = await this.read(id);
    if (draft.sequence !== input.expectedSequence) throw new DraftConflictError("Draft changed; reload before answering");
    if (draft.status !== "waiting_for_answers") throw new Error("Draft is not waiting for human answers");
    const request = draft.runtimeInputs.find(request => request.id === input.requestId && request.active);
    if (!request || request.answer !== null) throw new Error("Runtime input is missing, superseded, or already answered");
    const answer = runtimeInputSchema.shape.answer.unwrap().parse({ text: input.answer, userId: input.userId, sequence: draft.sequence + 1 });
    request.answer = answer;
    recordEvent(draft, "runtime-input.answer", request.id, answer.userId);
    await this.store.save(draft, input.expectedSequence);
    return structuredClone(draft);
  }

  async execute(id: string, context: MutationContext, input: ChainCommand): Promise<ChainDraft> {
    const command = commandSchema.parse(input);
    const draft = await this.read(id);
    if (draft.sequence !== context.expectedSequence || draft.attemptId !== context.attemptId) {
      throw new DraftConflictError("Draft version or run attempt changed; reload the current checkpoint");
    }
    const phase = currentPhase(draft);
    if (command.type === "artifact.put" || command.type === "artifact.remove") {
      if (!(phase.type === "artifact" || phase.type === "builtin") || !phase.artifacts.includes(command.ref)) {
        throw new Error(`Artifact ${command.ref} is outside the current phase`);
      }
      if (!artifactBlock(draft.definition, command.ref).writable) throw new Error(`Artifact ${command.ref} is readonly`);
      if (command.type === "artifact.put") putArtifact(draft, command, draft.phase);
      else {
        const key = itemKey(draft, command.ref, command.key);
        if (draft.frozen.some(item => item.ref === command.ref && item.key === key)) throw new Error(`Artifact ${command.ref}/${key} is frozen`);
        if (draft.writeRules.some(rule => rule.ref === command.ref)) throw new Error(`Artifact ${command.ref} is sealed or append-only`);
        const index = draft.artifacts.findIndex(item => item.ref === command.ref && item.key === key);
        if (index < 0) throw new Error(`Artifact ${command.ref}/${key} does not exist`);
        draft.artifacts.splice(index, 1);
      }
    } else if (command.type === "metadata.set") {
      if (phase.type !== "metadata" || !phase.inputs.includes(command.input)) throw new Error(`Input ${command.input} is outside the metadata phase`);
      draft.inputs[command.input] = command.value;
    } else if (command.type === "runtime-input.put" || command.type === "runtime-input.remove") {
      const handler = phase.type === "builtin" && Object.hasOwn(this.builtins, phase.builtin) ? this.builtins[phase.builtin] : undefined;
      if (!handler?.runtimeInputs) throw new Error("Runtime inputs are not enabled for the current phase");
      const existing = draft.runtimeInputs.find(request => request.key === command.key && request.active);
      if (existing && (existing.phase !== draft.phase || existing.answer !== null)) throw new Error("Runtime input already has a human answer or belongs to another phase; use a new key");
      if (command.type === "runtime-input.remove") {
        if (!existing) throw new Error(`Runtime input ${command.key} does not exist`);
        existing.active = false;
      } else {
        const { type: _type, ...fields } = command;
        if (existing) Object.assign(existing, fields, { attemptId: draft.attemptId });
        else draft.runtimeInputs.push({ ...fields, id: `${draft.id}:${draft.sequence + 1}`, phase: draft.phase!, attemptId: draft.attemptId, active: true, answer: null });
      }
    } else if (command.type === "phase.rewind") {
      this.rewind(draft, command.to);
    } else {
      await this.complete(draft, command.confirmation);
    }
    recordEvent(draft, command.type === "phase.complete" && draft.status === "waiting_for_answers" ? "phase.wait" : command.type,
      command.type === "phase.rewind" ? command.reason : command.type === "phase.complete" ? command.confirmation : undefined);
    await this.store.save(draft, context.expectedSequence);
    return structuredClone(draft);
  }

  private rewind(draft: ChainDraft, to: string): void {
    const order = Object.keys(draft.definition.phases);
    const target = order.indexOf(to);
    if (target < 0 || target >= order.indexOf(draft.phase!)) throw new Error("Rewind target must be an earlier phase");
    const firstOwner = new Map<string, number>();
    for (const [index, id] of order.entries()) {
      const phase = draft.definition.phases[id]!;
      if (phase.type === "artifact" || phase.type === "builtin") {
        for (const ref of phase.artifacts) if (!firstOwner.has(ref)) firstOwner.set(ref, index);
      }
    }
    draft.artifacts = draft.artifacts.filter(item => (firstOwner.get(item.ref) ?? -1) <= target);
    draft.frozen = draft.frozen.filter(item => order.indexOf(item.phase) < target);
    draft.writeRules = draft.writeRules.filter(rule => order.indexOf(rule.phase) < target);
    for (const request of draft.runtimeInputs) if (order.indexOf(request.phase) >= target) request.active = false;
    draft.completedPhases = draft.completedPhases.slice(0, target);
    draft.phase = to;
  }

  private async complete(draft: ChainDraft, confirmation?: string): Promise<void> {
    const phase = currentPhase(draft);
    const handler = phase.type === "builtin" && Object.hasOwn(this.builtins, phase.builtin) ? this.builtins[phase.builtin] : undefined;
    if (handler?.runtimeInputs && pendingRuntimeInputs(draft).some(request => request.phase === draft.phase)) {
      draft.status = "waiting_for_answers";
      return;
    }
    const errors = phase.inputs.filter(key => draft.definition.inputs[key]?.required && !draft.inputs[key])
      .map(key => `Required input ${key} is missing`);
    if (phase.type === "confirmation" && !confirmation) errors.push("An explicit confirmation is required");
    if (errors.length) throw new PhaseValidationError(errors);
    if (phase.type === "builtin") {
      if (!handler) throw new PhaseValidationError([`Builtin ${phase.builtin} is not implemented`]);
      const result = await handler(structuredClone(draft));
      if (result.errors.length) throw new PhaseValidationError(result.errors);
      for (const write of result.artifacts ?? []) putArtifact(draft, write, draft.phase);
      for (const ref of result.freeze ?? []) {
        artifactBlock(draft.definition, ref);
        for (const item of draft.artifacts.filter(item => item.ref === ref)) {
          if (!draft.frozen.some(frozen => frozen.ref === item.ref && frozen.key === item.key)) {
            draft.frozen.push({ ref, key: item.key, phase: draft.phase! });
          }
        }
      }
      for (const rule of result.writeRules ?? []) {
        artifactBlock(draft.definition, rule.ref);
        draft.writeRules.push({ ...rule, phase: draft.phase! });
      }
    }
    if (phase.type === "artifact" || phase.type === "builtin") {
      const missing = requiredArtifactErrors(draft, phase.artifacts);
      if (missing.length) throw new PhaseValidationError(missing);
    }
    const order = Object.keys(draft.definition.phases);
    const next = order[order.indexOf(draft.phase!) + 1];
    if (!next) {
      const allRefs = Object.entries(draft.definition.artifacts).flatMap(([id, artifact]) => Object.keys(artifact.blocks).map(block => `${id}.${block}`));
      const missing = requiredArtifactErrors(draft, allRefs);
      if (missing.length) throw new PhaseValidationError(missing);
    }
    draft.completedPhases.push(draft.phase!);
    draft.phase = next ?? null;
    if (!next) draft.status = "completed";
  }
}
