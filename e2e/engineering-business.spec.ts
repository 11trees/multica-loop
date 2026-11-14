import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { TestApiClient } from "./fixtures";

test("native business roles preserve a human choice through an intent return and publish an independently reviewed specification", async () => {
  test.setTimeout(420000);
  test.skip(process.env.MULTICA_ENGINEERING_ENABLED !== "true" || !process.env.MULTICA_ENGINEERING_CLI, "Requires the managed engineering service and management CLI");
  const api = new TestApiClient(); await api.loginLocally();
  const workspace = (await api.getWorkspaces()).find(item => item.slug === "loopwork-local")!; api.setWorkspaceId(workspace.id); api.setWorkspaceSlug(workspace.slug);
  const directory = await mkdtemp(join(tmpdir(), "business-native-")), repository = join(directory, "repository");
  execFileSync("git", ["init", "-q", repository]);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  git("config", "user.name", "Business fixture"); git("config", "user.email", "fixture@example.invalid"); await writeFile(join(repository, "README.md"), "Readonly business fixture\n"); git("add", "README.md"); git("commit", "-qm", "Fixture"); const baseCommit = git("rev-parse", "HEAD");
  try {
    const intent = await api.seedEngineeringRun(), design = await api.seedEngineeringRun(intent.issueId), spec = await api.seedEngineeringRun(intent.issueId), review = await api.seedEngineeringRun(intent.issueId);
    const project = await api.createProject(`Business fixture ${intent.issueId}`);
    for (const run of [intent, design, spec, review]) { await api.finishEngineeringRun(run.taskId); await api.attachEngineeringProject(run.taskId, project.id, repository); }
    await api.configureBusinessEngineering(intent.issueId, { expected_revision: 0, repository_path: repository, input: "A reader continues the selected item. Preserve the selection across review.", roles: { intent: intent.agentId, business_design: design.agentId, specification: spec.agentId, review: review.agentId }, decision_mode: "balanced", auto_continue: true });
    let owner = intent;
    const cli = (name: string, payload?: unknown) => JSON.parse(execFileSync(resolve(process.env.MULTICA_ENGINEERING_CLI!), ["engineering", name, ...(payload ? ["--payload", JSON.stringify(payload)] : [])], { cwd: directory, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MULTICA_SERVER_URL: owner.apiBase, MULTICA_TOKEN: owner.taskToken, MULTICA_WORKSPACE_ID: workspace.id, MULTICA_TASK_ID: owner.taskId, MULTICA_AGENT_ID: owner.agentId } }));
    let state: ReturnType<typeof cli>;
    const begin = async (agentId: string) => {
      await expect.poll(() => api.queuedEngineeringRun(intent.issueId, agentId), { timeout: 40000 }).not.toBeNull(); owner = await api.claimEngineeringRun((await api.queuedEngineeringRun(intent.issueId, agentId))!);
      await api.bindEngineeringRepository(owner.taskId, repository); state = cli("start");
    };
    const command = (command: unknown) => { state = cli("command", { expected_sequence: state.draft.sequence, command }); };
    const next = () => command({ type: "phase.complete" });
    const put = (namespace: string, block: string, content: unknown, key?: string) => command({ type: "artifact.put", ref: `${namespace}.${block}`, content: typeof content === "string" ? content : JSON.stringify(content), ...(key ? { key } : {}) });
    await begin(intent.agentId); expect(state.chain).toBe("idea-context"); const originalDraft = state.draft.id;
    put("requirement-intent", "discovery", "The original idea concerns continuation of a chosen item"); next(); next();
    command({ type: "decision.propose", decision: { key: "selection", type: "business", title: "Continue target", question: "Which item should Continue open?", impact: "Changes the reader outcome", options: [{ id: "selected", label: "Selected item", consequence: "Preserve context" }, { id: "latest", label: "Latest item", consequence: "Change context" }], recommendation: { option: "selected", authority: "user", reason: "Retain the reader context" }, dependencies: [] } }); next(); command({ type: "decision.ask", key: "selection" }); next(); const questionId = state.draft.runtimeInputs[0].id; await api.finishEngineeringRun(owner.taskId);
    await api.engineeringVerification(intent.issueId, "answer", { expected_sequence: state.draft.sequence, request_id: questionId, selected_option: "selected", answer: "" });
    await begin(intent.agentId); expect(state.draft.id).toBe(originalDraft); command({ type: "decision.resolve", key: "selection", option: "selected", authority: "user", decision: "Continue the selected item", rationale: "Authenticated human choice", evidence: questionId }); next();
    const synthesize = () => {
      put("requirement-intent", "answer-review", "The original selected-item choice remains authoritative"); next();
      put("requirement-intent", "problem", "Readers need continuity across sessions"); put("requirement-intent", "actors", { name: "Reader", role: "User", need: "Continue reading" }, "reader"); put("requirement-intent", "goals", { content: "Continue selected item", source: `Authenticated choice ${questionId}` }, "continue"); put("requirement-intent", "success", { outcome: "Selected item opens", measure: "Exact item identity is retained" }, "continue"); next(); next();
    };
    synthesize(); await api.finishEngineeringRun(owner.taskId);
    await begin(design.agentId); expect(state.business.upstream[0].draftId).toBe(originalDraft);
    put("business-solution", "exploration", "The selected item rule is known; continuity measurement needs a clearer boundary"); next(); next(); next(); next(); put("business-solution", "answer-review", "Keep the selected-item human choice; return the success boundary"); next(); put("business-solution", "upstream-gaps", { reason: "Clarify retained item identity as the success boundary", evidence: "Original intent success wording" }, "success-boundary"); next(); next(); expect(state.conclusion).toMatchObject({ disposition: "return_revision", target: "intent" }); await api.finishEngineeringRun(owner.taskId);
    await begin(intent.agentId); expect(state.draft.id).not.toBe(originalDraft); expect(state.business.generation).toBe(2); expect(state.draft.decisions[0].resolution).toMatchObject({ option: "selected", userId: intent.userId, questionId }); expect(state.draft.runtimeInputs[0].active).toBe(false); expect(state.business.returnReason).toMatchObject({ target: "intent" });
    const forbidden = await fetch(`${owner.apiBase}/api/issues/${intent.issueId}/engineering/business-analysis`, { method: "POST", headers: { Authorization: `Bearer ${owner.taskToken}`, "Content-Type": "application/json" }, body: JSON.stringify({}) }); expect(forbidden.status).toBe(403);
    await writeFile(join(repository, "unexpected.txt"), "Do not change readonly business code"); expect(() => cli("status")).toThrow(); await rm(join(repository, "unexpected.txt"));
    await api.updateIssue(intent.issueId, { project_id: null, suppress_run: true }); expect(() => cli("status")).toThrow();
    await api.updateIssue(intent.issueId, { project_id: project.id, suppress_run: true }); expect(cli("status").draft.id).toBe(state.draft.id);
    put("requirement-intent", "discovery", "Clarified success requires the exact selected item identity"); next(); next(); next(); next(); synthesize(); await api.finishEngineeringRun(owner.taskId);
    await begin(design.agentId); expect(state.business.generation).toBe(2); expect(state.business.previous.disposition).toBe("return_revision");
    put("business-solution", "exploration", "Explore selected-item continuation and absent-item recovery"); next(); next(); next(); next(); put("business-solution", "answer-review", "No new choices; retain selected item"); next();
    put("business-solution", "summary", "Continue the selected item"); put("business-solution", "actors", { name: "Reader", responsibility: "Choose an item" }, "reader"); put("business-solution", "scenarios", { kind: "main", actor: "Reader", trigger: "Continue", outcome: "Selected item opens" }, "continue"); put("business-solution", "flows", { scenario: "Continue", action: "Activate Continue", result: "Selected item opens" }, "open"); put("business-solution", "rules", { content: "Use the selected item", rationale: "Authenticated human choice" }, "selection"); put("business-solution", "scope", { direction: "included", content: "Selected-item continuation" }, "continue"); put("business-solution", "success", { outcome: "Selected item opens", measure: "Exact item identity" }, "continue"); next(); next(); await api.finishEngineeringRun(owner.taskId);
    const specification = "# Reader specification\n\n## Outcome\nContinue opens the selected item.\n\n## ACCEPTANCE\nActivate Continue and observe the exact selected item identity.";
    await begin(spec.agentId); expect(state.business.upstream).toHaveLength(2); put("requirement-specification", "draft", "Original idea, human choice, revised intent and business solution reconciled"); next(); put("requirement-specification", "verification", "Every business outcome has an observable acceptance"); put("requirement-specification", "final", specification); next(); next(); await api.finishEngineeringRun(owner.taskId);
    await begin(review.agentId); expect(state.business.upstream[2].artifact.content).toBe(specification); put("specification-review", "findings", { subject: "Original reader outcome and authenticated selection", verdict: "passed", evidence: "Frozen intent, solution and specification ACCEPTANCE", reason: "Preserves exact selected item identity" }, "selection"); next(); next(); put("specification-review", "verdict-summary", "Independent review accepts the complete specification"); put("specification-review", "approved-specification", specification); next(); next(); await api.finishEngineeringRun(owner.taskId);
    const overview = await api.engineeringOverview(intent.issueId); expect(overview.business).toMatchObject({ stage: "review", reading_enabled: false }); expect(overview.business.history).toHaveLength(6); expect(overview.business.history.filter((entry: { superseded: boolean }) => entry.superseded)).toHaveLength(2); expect(overview.business.history.at(-1).result.artifact.content).toBe(specification);
    await expect(api.updateIssue(intent.issueId, { status: "done", suppress_run: true })).rejects.toThrow(/409.*specification reading/i); expect(git("rev-parse", "HEAD")).toBe(baseCommit); expect(git("status", "--porcelain")).toBe("");
  } finally { await api.cleanup(); await rm(directory, { recursive: true, force: true }); }
});
