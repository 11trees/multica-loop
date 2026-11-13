// @vitest-environment node
import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { parseCommandChainDefinition, type CommandChainProfile } from "./index";

const development = readFileSync(new URL("./fixtures/development.yaml", import.meta.url), "utf8");
const verification = readFileSync(new URL("./definitions/verification.yaml", import.meta.url), "utf8");
const developmentProfile: CommandChainProfile = {
  id: "development",
  agent: "dev-agent",
  requiredBuiltins: ["delivery-spec", "implementation-evidence", "command-verification"],
  builtins: {
    "delivery-spec": { acceptsArtifacts: false },
    "implementation-evidence": { acceptsArtifacts: true },
    "command-verification": { acceptsArtifacts: true },
  },
  metadataKeys: ["tracking.requirement_card_id"],
  repositoryAdapters: [],
};
const verificationProfile: CommandChainProfile = {
  id: "verification",
  agent: "test-agent",
  requiredBuiltins: ["verification-inputs", "verification-plan", "verification-execution", "verification-finalize"],
  builtins: {
    "verification-inputs": { acceptsArtifacts: false },
    "verification-plan": { acceptsArtifacts: true },
    "verification-execution": { acceptsArtifacts: true },
    "verification-finalize": { acceptsArtifacts: false },
  },
  metadataKeys: [],
  repositoryAdapters: [],
};

describe("LoopWork authoring definition import", () => {
  it("reads the existing development chain without its database or runner", () => {
    const { definition, phaseOrder } = parseCommandChainDefinition(development, developmentProfile);
    expect(phaseOrder).toEqual(["delivery_spec", "implement", "review", "developer_verify", "commit", "finalize"]);
    expect(definition.inputs["requirement-card"]).toEqual({ metadata: "tracking.requirement_card_id", required: false });
    expect(definition.artifacts.development?.blocks["code-review"]?.required).toBe(true);
    expect(definition.phases.implement).toEqual({
      type: "builtin", builtin: "implementation-evidence", artifacts: ["development.recovery-resolutions"], inputs: [],
    });
  });

  it("preserves the independent verification plan before execution", () => {
    const { definition, phaseOrder } = parseCommandChainDefinition(verification, verificationProfile);
    expect(phaseOrder).toEqual(["inputs", "plan", "execute", "evidence_review", "finalize"]);
    expect(definition.artifacts.verification?.blocks.sources?.writable).toBe(false);
    expect(definition.artifacts.verification?.blocks.scenarios?.fields.channel?.values).toEqual(["frontend", "api"]);
    expect(definition.artifacts.verification?.blocks.results?.fields.failureKind?.values)
      .toEqual(["implementation", "specification", "environment", "inconclusive"]);
  });

  it("does not let YAML replace host-owned validators or transitions", () => {
    const raw = parse(verification);
    raw.phases.finalize.transitions = ["done"];
    expect(() => parseCommandChainDefinition(stringify(raw), verificationProfile)).toThrow(/transitions/);
  });

  it("rejects a definition bound to a different agent", () => {
    expect(() => parseCommandChainDefinition(development.replace("agent: dev-agent", "agent: test-agent"), developmentProfile))
      .toThrow(/Expected chain development for agent dev-agent/);
  });

  it("rejects removal, duplication and reordering of required verification builtins", () => {
    const missing = parse(verification);
    delete missing.phases.plan;
    expect(() => parseCommandChainDefinition(stringify(missing), verificationProfile)).toThrow(/Missing required builtin verification-plan/);
    const duplicate = parse(verification);
    duplicate.phases.another_plan = duplicate.phases.plan;
    expect(() => parseCommandChainDefinition(stringify(duplicate), verificationProfile)).toThrow(/Duplicate builtin verification-plan/);
    const reordered = parse(verification);
    reordered.phases = { ...reordered.phases, plan: reordered.phases.execute, execute: reordered.phases.plan };
    expect(() => parseCommandChainDefinition(stringify(reordered), verificationProfile)).toThrow(/relative order/);
  });

  it.each([
    ["unknown builtin", (raw: any) => { raw.phases.finalize.builtin = "skip-verification"; }, /unsupported builtin/],
    ["unknown artifact", (raw: any) => { raw.phases.evidence_review.artifacts = ["verification.missing"]; }, /unknown artifact block/],
    ["unknown input", (raw: any) => { raw.phases.finalize.inputs = ["missing"]; }, /unknown input/],
    ["readonly write", (raw: any) => { raw.phases.evidence_review.artifacts = ["verification.sources"]; }, /readonly artifact/],
    ["empty phases", (raw: any) => { raw.phases = {}; }, /at least one phase/],
  ])("rejects %s", (_name, mutate, error) => {
    const raw = parse(verification);
    mutate(raw);
    expect(() => parseCommandChainDefinition(stringify(raw), verificationProfile)).toThrow(error);
  });

  it("requires adapter and metadata references to be supplied by the host", () => {
    const raw = parse(development);
    raw.artifacts.development.type = "repository";
    raw.artifacts.development.adapter = "openspec";
    expect(() => parseCommandChainDefinition(stringify(raw), developmentProfile)).toThrow(/unsupported adapter openspec/);
    expect(() => parseCommandChainDefinition(development, { ...developmentProfile, metadataKeys: [] }))
      .toThrow(/unsupported metadata/);
  });

  it("rejects malformed field definitions and ambiguous YAML", () => {
    const raw = parse(verification);
    delete raw.artifacts.verification.blocks.results.fields.status.values;
    expect(() => parseCommandChainDefinition(stringify(raw), verificationProfile)).toThrow(/Enum fields/);
    expect(() => parseCommandChainDefinition(`${development}\nid: development\n`, developmentProfile)).toThrow(/unique/);
    expect(() => parseCommandChainDefinition(development.replace("version: 1", "version: 2"), developmentProfile)).toThrow();
  });
});
