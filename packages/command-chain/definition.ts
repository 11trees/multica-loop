import { parse } from "yaml";
import { z } from "zod";

const text = z.string().trim().min(1);
// Integer-like keys are disallowed so JavaScript preserves YAML phase order.
const identifier = text.regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
const references = z.array(text);
const field = z.strictObject({
  type: z.enum(["string", "enum", "array"]),
  required: z.boolean().default(false),
  label: text.optional(),
  values: z.array(text).min(1).optional(),
  minItems: z.number().int().positive().optional(),
}).refine(value => value.type !== "enum" || Boolean(value.values?.length), {
  message: "Enum fields must declare nonempty values",
});

const block = z.strictObject({
  title: text,
  cardinality: z.enum(["one", "many"]),
  format: z.enum(["markdown", "yaml", "text"]),
  writable: z.boolean().default(true),
  required: z.boolean().default(false),
  render: z.boolean().default(true),
  fields: z.record(identifier, field).default({}),
});

const artifact = z.strictObject({
  type: z.enum(["builtin", "repository"]),
  adapter: text.nullish(),
  title: text,
  blocks: z.record(identifier, block),
}).superRefine((value, ctx) => {
  if ((value.type === "repository") !== Boolean(value.adapter)) {
    ctx.addIssue({ code: "custom", message: "Only repository artifacts must name an adapter" });
  }
});

const phase = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("builtin"),
    builtin: text,
    artifacts: references.default([]),
    inputs: references.default([]),
  }),
  z.strictObject({
    type: z.literal("artifact"),
    artifacts: references.min(1),
    inputs: references.default([]),
    instructions: text,
  }),
  z.strictObject({
    type: z.literal("confirmation"),
    inputs: references.default([]),
    instructions: text,
  }),
  z.strictObject({
    type: z.literal("metadata"),
    inputs: references.min(1),
    instructions: text,
  }),
]);

export const commandChainDefinitionSchema = z.strictObject({
  version: z.literal(1),
  id: identifier,
  agent: identifier,
  inputs: z.record(identifier, z.strictObject({
    metadata: text,
    required: z.boolean().default(false),
    default: text.optional(),
  })).default({}),
  artifacts: z.record(identifier, artifact),
  phases: z.record(identifier, phase),
});

export type CommandChainDefinition = z.infer<typeof commandChainDefinitionSchema>;

export type BuiltinCapability = {
  acceptsArtifacts: boolean;
  allowsReadonlyArtifacts?: boolean;
};

// The host supplies these capabilities; YAML cannot weaken its own requirements.
export type CommandChainProfile = {
  id: string;
  agent: string;
  requiredBuiltins: readonly string[];
  builtins: Readonly<Record<string, BuiltinCapability>>;
  metadataKeys: readonly string[];
  repositoryAdapters: readonly string[];
};

export type LoadedCommandChain = {
  definition: CommandChainDefinition;
  phaseOrder: string[];
};

/** Loads authoring definitions only; it does not execute builtins or authorize delivery. */
export function parseCommandChainDefinition(source: string, profile: CommandChainProfile): LoadedCommandChain {
  const chain = commandChainDefinitionSchema.parse(parse(source));
  if (chain.id !== profile.id || chain.agent !== profile.agent) {
    throw new Error(`Expected chain ${profile.id} for agent ${profile.agent}`);
  }
  const phaseOrder = Object.keys(chain.phases);
  if (!phaseOrder.length) throw new Error("A command chain must have at least one phase");

  const inputMetadata = new Set<string>();
  for (const [key, input] of Object.entries(chain.inputs)) {
    if (!profile.metadataKeys.includes(input.metadata)) {
      throw new Error(`Input ${key} refers to unsupported metadata ${input.metadata}`);
    }
    if (inputMetadata.has(input.metadata)) throw new Error(`Duplicate metadata mapping ${input.metadata}`);
    inputMetadata.add(input.metadata);
  }
  for (const [key, value] of Object.entries(chain.artifacts)) {
    if (value.adapter && !profile.repositoryAdapters.includes(value.adapter)) {
      throw new Error(`Artifact ${key} refers to unsupported adapter ${value.adapter}`);
    }
  }

  const builtinOrder: string[] = [];
  for (const [key, value] of Object.entries(chain.phases)) {
    for (const input of value.inputs) {
      if (!Object.hasOwn(chain.inputs, input)) throw new Error(`Phase ${key} refers to unknown input ${input}`);
    }
    let capability: BuiltinCapability | undefined;
    if (value.type === "builtin") {
      capability = Object.hasOwn(profile.builtins, value.builtin) ? profile.builtins[value.builtin] : undefined;
      if (!capability) throw new Error(`Phase ${key} refers to unsupported builtin ${value.builtin}`);
      if (builtinOrder.includes(value.builtin)) throw new Error(`Duplicate builtin ${value.builtin}`);
      builtinOrder.push(value.builtin);
      if (value.artifacts.length && !capability.acceptsArtifacts) {
        throw new Error(`Builtin ${value.builtin} does not accept artifact blocks`);
      }
    }
    if (value.type === "builtin" || value.type === "artifact") {
      for (const ref of value.artifacts) {
        const parts = ref.split(".");
        const [artifactId, blockId] = parts;
        const artifactValue = artifactId && Object.hasOwn(chain.artifacts, artifactId) ? chain.artifacts[artifactId] : undefined;
        const blockValue = blockId && artifactValue && Object.hasOwn(artifactValue.blocks, blockId) ? artifactValue.blocks[blockId] : undefined;
        if (parts.length !== 2 || !blockValue) throw new Error(`Phase ${key} refers to unknown artifact block ${ref}`);
        if (!blockValue.writable && !capability?.allowsReadonlyArtifacts) {
          throw new Error(`Phase ${key} cannot write readonly artifact block ${ref}`);
        }
      }
    }
  }
  let previous = -1;
  for (const builtin of profile.requiredBuiltins) {
    const index = builtinOrder.indexOf(builtin);
    if (index < 0) throw new Error(`Missing required builtin ${builtin}`);
    if (index <= previous) throw new Error("Required builtins must retain their relative order");
    previous = index;
  }
  return { definition: chain, phaseOrder };
}
