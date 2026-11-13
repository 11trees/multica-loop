import { parse, stringify } from "yaml";
import type { CommandChainDefinition } from "./definition";

export type ArtifactBlock = CommandChainDefinition["artifacts"][string]["blocks"][string];

export function artifactBlock(definition: CommandChainDefinition, ref: string): ArtifactBlock {
  const parts = ref.split(".");
  const [artifactId, blockId] = parts;
  const artifact = artifactId && Object.hasOwn(definition.artifacts, artifactId)
    ? definition.artifacts[artifactId] : undefined;
  const block = artifact && blockId && Object.hasOwn(artifact.blocks, blockId) ? artifact.blocks[blockId] : undefined;
  if (parts.length !== 2 || !block) throw new Error(`Unknown artifact block ${ref}`);
  return block;
}

/** One YAML object per item; cardinality is expressed by stable item keys. */
export function validateArtifactContent(block: ArtifactBlock, content: string): string {
  if (!content.trim()) throw new Error("Artifact content must not be empty");
  if (block.format !== "yaml") return content.trim();
  const value: unknown = parse(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Artifact must be a YAML object");
  const fields = value as Record<string, unknown>;
  for (const name of Object.keys(fields)) {
    if (!Object.hasOwn(block.fields, name)) throw new Error(`Undeclared artifact field ${name}`);
  }
  for (const [name, field] of Object.entries(block.fields)) {
    const input = fields[name];
    if (input == null) {
      if (field.required) throw new Error(`Required artifact field ${name} is missing`);
      continue;
    }
    if (field.type === "string" && (typeof input !== "string" || !input.trim())) {
      throw new Error(`Artifact field ${name} must be a nonempty string`);
    }
    if (field.type === "enum" && (typeof input !== "string" || !field.values?.includes(input))) {
      throw new Error(`Artifact field ${name} must be one of ${field.values?.join(", ")}`);
    }
    if (field.type === "array" && (!Array.isArray(input) || input.length < (field.minItems ?? 0))) {
      throw new Error(`Artifact field ${name} must be an array with at least ${field.minItems ?? 0} items`);
    }
  }
  return stringify(fields).trim();
}
