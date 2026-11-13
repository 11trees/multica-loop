import { parse } from "yaml";
import { z } from "zod";
import { artifactBlock, validateArtifactContent, type ArtifactBlock } from "./artifacts";
import { applyDecisionCommand, decisionGraphErrors, decisionModeSchema, decisionResolutionErrors } from "./decisions";
import type { CommandChainProfile } from "./definition";
import { draftSchema, PhaseValidationError, pendingRuntimeInputs, type ArtifactItem, type BuiltinHandlers, type ChainCommand, type ChainDraft } from "./runtime";

export const businessStageSchema = z.enum(["intent", "business_design", "specification", "review"]);
export type BusinessStage = z.infer<typeof businessStageSchema>;
export const businessContractSchema = z.strictObject({
  binding: draftSchema.shape.binding,
  stage: businessStageSchema,
  decisionMode: decisionModeSchema,
});
export type BusinessContract = z.infer<typeof businessContractSchema>;

const decisionBuiltins = {
  "decision-proposal": { acceptsArtifacts: false },
  "decision-resolution": { acceptsArtifacts: false },
  "decision-answer-review": { acceptsArtifacts: true },
};
function profile(id: string, agent: string, decisions = false): CommandChainProfile {
  return { id, agent, requiredBuiltins: [...(decisions ? Object.keys(decisionBuiltins) : []), "business-analysis-finalize"],
    builtins: { ...(decisions ? decisionBuiltins : {}), "business-analysis-finalize": { acceptsArtifacts: false } },
    metadataKeys: [], repositoryAdapters: [] };
}
export const businessProfiles: Readonly<Record<BusinessStage, CommandChainProfile>> = {
  intent: profile("idea-context", "idea-context-agent", true),
  business_design: profile("business-design", "business-design-agent", true),
  specification: profile("requirement-spec", "requirement-spec-agent"),
  review: profile("spec-review", "spec-review-agent"),
};
const artifactIds: Record<BusinessStage, string> = {
  intent: "requirement-intent", business_design: "business-solution", specification: "requirement-specification", review: "specification-review",
};
function gapBlock(stage: BusinessStage) { return stage === "intent" ? null : stage === "review" ? "gaps" : "upstream-gaps"; }
function rows(draft: Readonly<ChainDraft>, stage: BusinessStage, block: string) {
  return draft.artifacts.filter(item => item.ref === `${artifactIds[stage]}.${block}`);
}
function value(item: ArtifactItem): Record<string, unknown> { return parse(item.content) as Record<string, unknown>; }
function bindingErrors(draft: Readonly<ChainDraft>, contract: BusinessContract) {
  const expected = businessProfiles[contract.stage];
  return [
    ...(Object.entries(contract.binding).some(([key, input]) => draft.binding[key as keyof typeof draft.binding] !== input) ? ["Frozen business analysis binding changed"] : []),
    ...(draft.definition.id !== expected.id || draft.definition.agent !== expected.agent ? ["Business analysis stage or agent changed"] : []),
    ...(Object.keys(draft.definition.artifacts).length !== 1 || !Object.hasOwn(draft.definition.artifacts, artifactIds[contract.stage]) ? ["Business analysis artifact namespace changed"] : []),
  ];
}
function outputErrors(draft: Readonly<ChainDraft>, stage: BusinessStage): string[] {
  const has = (block: string) => rows(draft, stage, block).length > 0;
  const missing = (blocks: string[]) => blocks.filter(block => !has(block)).map(block => `Business analysis ${stage} requires ${block}`);
  const gaps = gapBlock(stage) ? rows(draft, stage, gapBlock(stage)!) : [];
  if (stage === "intent") return missing(["problem", "actors", "goals", "success"]);
  if (stage === "business_design") {
    if (!gaps.length) return missing(["summary", "actors", "scenarios", "flows", "rules", "scope", "success"]);
    return ["summary", "actors", "scenarios", "flows", "rules", "states", "scope", "success", "dependencies"]
      .filter(has).map(block => `Intent return cannot include solution output ${block}`);
  }
  if (!gaps.length) return missing(stage === "specification" ? ["draft", "verification", "final"] : ["approved-specification"]);
  const targets = new Set(gaps.map(item => value(item).target));
  return [
    ...(targets.size !== 1 ? ["All business analysis gaps must have one responsibility target"] : []),
    ...(has(stage === "specification" ? "final" : "approved-specification") ? ["Upstream gaps cannot coexist with final or approved specification"] : []),
    ...(stage === "review" && !rows(draft, stage, "findings").some(item => value(item).verdict === "gap") ? ["Blocking review gaps require a gap finding"] : []),
  ];
}
function artifactErrors(draft: Readonly<ChainDraft>): string[] {
  const errors: string[] = [], keys = new Set<string>();
  for (const item of draft.artifacts) {
    try {
      const block = artifactBlock(draft.definition, item.ref);
      validateArtifactContent(block, item.content);
      if (block.cardinality === "one" ? item.key !== "" : !item.key.trim()) errors.push(`Artifact ${item.ref} has invalid cardinality key`);
      const key = JSON.stringify([item.ref, item.key]);
      if (keys.has(key)) errors.push(`Duplicate artifact ${item.ref}/${item.key}`);
      keys.add(key);
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  for (const [id, artifact] of Object.entries(draft.definition.artifacts)) for (const [block, definition] of Object.entries(artifact.blocks)) {
    if (definition.required && !draft.artifacts.some(item => item.ref === `${id}.${block}`)) errors.push(`Required artifact ${id}.${block} is missing`);
  }
  return errors;
}
function finalErrors(draft: Readonly<ChainDraft>, contract: BusinessContract): string[] {
  const errors = [...bindingErrors(draft, contract), ...artifactErrors(draft)];
  // Inspect structured values only after the declared fields have been validated.
  if (errors.length) return errors;
  if (contract.stage === "intent" || contract.stage === "business_design") errors.push(...decisionResolutionErrors(draft));
  else if (draft.decisions?.length || draft.runtimeInputs.length) errors.push("Specification authoring and review cannot create decision questions");
  if (pendingRuntimeInputs(draft).length) errors.push("Business analysis still has unanswered questions");
  return [...errors, ...outputErrors(draft, contract.stage)];
}
export function createBusinessHandlers(input: BusinessContract): BuiltinHandlers {
  const contract = businessContractSchema.parse(input);
  const assertBinding = (draft: Readonly<ChainDraft>) => {
    const errors = bindingErrors(draft, contract);
    if (errors.length) throw new PhaseValidationError(errors);
  };
  const decide = (allowed: string[]) => (draft: ChainDraft, command: ChainCommand) => {
    if (!allowed.includes(command.type)) throw new Error("Decision command is outside the current phase");
    applyDecisionCommand(draft, command, contract.decisionMode);
  };
  const handlers: BuiltinHandlers = {
    ...(contract.stage === "intent" || contract.stage === "business_design" ? {
      "decision-proposal": Object.assign((draft: Readonly<ChainDraft>) => ({ errors: decisionGraphErrors(draft.decisions ?? []) }), {
        command: decide(["decision.propose", "decision.remove"]),
        rewind: (draft: ChainDraft, to: string) => {
          const phases = Object.entries(draft.definition.phases);
          const proposal = phases.findIndex(([, phase]) => phase.type === "builtin" && phase.builtin === "decision-proposal");
          if (phases.findIndex(([id]) => id === to) <= proposal) for (const node of draft.decisions ?? []) { node.status = "proposed"; delete node.resolution; }
        },
      }),
      "decision-resolution": Object.assign((draft: Readonly<ChainDraft>) => ({ errors: decisionResolutionErrors(draft) }), {
        runtimeInputs: true, beforePause: assertBinding, command: decide(["decision.ask", "decision.resolve", "decision.reopen"]),
      }),
      "decision-answer-review": (draft: Readonly<ChainDraft>) => ({ errors: decisionResolutionErrors(draft) }),
    } : {}),
    "business-analysis-finalize": Object.assign((draft: Readonly<ChainDraft>) => ({ errors: finalErrors(draft, contract) }), {
      beforeComplete: assertBinding, finalize: (draft: Readonly<ChainDraft>) => finalErrors(draft, contract),
    }),
  };
  return handlers;
}

const primaryFields = ["claim", "name", "title", "content", "outcome", "action", "statement", "reason", "subject", "state", "expected", "finding", "summary", "target", "kind"];
const enumLabels: Record<string, string> = { high: "高", medium: "中", low: "低", included: "范围内", excluded: "范围外", main: "主流程", exception: "异常流程", recovery: "恢复流程", passed: "通过", gap: "存在缺口", intent: "需求意图", business_design: "业务方案", specification: "需求规格" };
function markdownValue(input: unknown): string {
  if (Array.isArray(input)) return input.map(String).join("、");
  if (input && typeof input === "object") return Object.entries(input).map(([key, item]) => `  - ${key}：${markdownValue(item)}`).join("\n");
  return String(input ?? "");
}
function link(label: string, url: string) { return `[${label.replaceAll("]", "\\]")}](${url.replaceAll(")", "%29")})`; }
function fieldValue(name: string, input: unknown, row: Record<string, unknown>): string {
  if (name === "sourceTitle" && typeof input === "string" && typeof row.sourceUrl === "string") return link(input, row.sourceUrl);
  if (typeof input === "string" && Object.hasOwn(enumLabels, input)) return enumLabels[input]!;
  if (typeof input === "string" && /^https?:\/\//.test(input)) return link(input, input);
  return markdownValue(input);
}
function yamlLines(items: readonly ArtifactItem[], block: ArtifactBlock): string[] {
  return items.flatMap(item => {
    const row = value(item), populated = Object.keys(block.fields).filter(key => row[key] != null && row[key] !== "");
    const primary = primaryFields.find(key => populated.includes(key)) ?? populated[0];
    if (!primary) return [];
    const content = fieldValue(primary, row[primary], row);
    return [`- ${["name", "title", "subject", "state"].includes(primary) ? `**${content}**` : content}`,
      ...populated.filter(key => key !== primary && !(key === "sourceUrl" && populated.includes("sourceTitle")))
        .map(key => `  - **${block.fields[key]!.label ?? key}**：${fieldValue(key, row[key], row)}`), ""];
  });
}
function embeddedMarkdown(content: string): string {
  let fenced = false;
  return content.trim().split("\n").map(line => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line; }
    return fenced ? line : line.replace(/^(\s*)(#{1,6})(\s+)/, (_, indent: string, hashes: string, spacing: string) => `${indent}${"#".repeat(Math.min(6, hashes.length + 2))}${spacing}`);
  }).join("\n");
}
function publishedArtifact(draft: Readonly<ChainDraft>, stage: BusinessStage, onlyBlock?: string): { title: string; content: string } {
  const artifact = draft.definition.artifacts[artifactIds[stage]]!;
  const populated = Object.entries(artifact.blocks).filter(([id, block]) => block.render && (!onlyBlock || id === onlyBlock))
    .map(([id, block]) => ({ block, items: rows(draft, stage, id) })).filter(entry => entry.items.length);
  if (populated.length === 1 && populated[0]!.block.format === "markdown") return { title: artifact.title, content: populated[0]!.items.map(item => item.content).join("\n\n").trim() };
  const lines = [`# ${artifact.title}`, ""];
  for (const { block, items } of populated) {
    lines.push(`## ${block.title}`, "");
    lines.push(...(block.format === "yaml" ? yamlLines(items, block) : items.flatMap(item => [block.format === "markdown" ? embeddedMarkdown(item.content) : item.content, ""])));
  }
  return { title: artifact.title, content: lines.join("\n").trim() };
}

/** This compiles a protocol conclusion, never a native issue completion or delivered-code verdict. */
export function compileBusinessConclusion(input: Readonly<ChainDraft>, frozenContract: BusinessContract) {
  const draft = draftSchema.parse(input), contract = businessContractSchema.parse(frozenContract);
  const errors = finalErrors(draft, contract);
  if (draft.status !== "completed" || draft.phase !== null || JSON.stringify(draft.completedPhases) !== JSON.stringify(Object.keys(draft.definition.phases))) errors.push("Business analysis is not completed");
  if (errors.length) throw new PhaseValidationError(errors);
  const block = gapBlock(contract.stage), gapItems = block ? rows(draft, contract.stage, block) : [];
  const common = { kind: "business-analysis" as const, stage: contract.stage, draftId: draft.id, attemptId: draft.attemptId, sequence: draft.sequence,
    binding: structuredClone(draft.binding), artifacts: structuredClone(draft.artifacts), decisions: structuredClone(draft.decisions ?? []), runtimeInputs: structuredClone(draft.runtimeInputs) };
  if (gapItems.length) {
    const target = contract.stage === "business_design" ? "intent" as const : businessStageSchema.exclude(["review"]).parse(value(gapItems[0]!).target);
    return { ...common, disposition: "return_revision" as const, target,
      reason: gapItems.map(item => `${item.key}：${String(value(item).reason)}`).join("；"),
      gaps: gapItems.map(item => ({ key: item.key, ...value(item) })), artifact: { ...publishedArtifact(draft, contract.stage, block!), title: "Business Analysis 缺口" } };
  }
  return { ...common, disposition: contract.stage === "review" ? "approved" as const : "advance" as const, gaps: [], artifact: publishedArtifact(draft, contract.stage) };
}
export type BusinessConclusion = ReturnType<typeof compileBusinessConclusion>;
