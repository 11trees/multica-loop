// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, it, expect } from "vitest";
import { AdminStore } from "./admin-store";
let directory: string, filename: string, store: AdminStore, now: number;
const workspaceId = randomUUID(), issueId = randomUUID();
const observation = (key: string) => ({ observationId: randomUUID(), workspaceId, issueId, scope: "work-item", scopeKey: key, fingerprint: "original", sourceVersion: "frozen-version", summary: "Original scope conflict", evidence: { original: "Preserve the original oracle" }, origin: "business" });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "admin-execution-")); filename = join(directory, "admin.sqlite"); now = 1000; store = new AdminStore(filename, () => now); });
afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
function setup() { const authority = store.acquireSupervisor("host", 30000, true)!, first = store.observe(authority, observation("first")), second = store.observe(authority, observation("second")); store.execution.configure({ expected_revision: 0, configuration: { provider: "codex", executablePath: "/fixture/codex" } }); store.execution.setIntent({ intent: "running", request_id: randomUUID() }); return { authority, first, second }; }
it("requires explicit runtime and intent, freezes configuration and allocates only one physical invocation fairly", () => {
    const observer = store.acquireSupervisor("host")!;
    store.observe(observer, observation("first"));
    expect(() => store.execution.setIntent({ intent: "running", request_id: "start" })).toThrow(/Configure/);
    store.execution.configure({ expected_revision: 0, configuration: { provider: "codex", executablePath: "/fixture/codex" } });
    expect(store.execution.claim(observer)).toBeNull();
    store.execution.setIntent({ intent: "running", request_id: "start" });
    expect(store.execution.claim(observer)).toBeNull();
    const authority = store.acquireSupervisor("host", 30000, true)!;
    const allocation = store.execution.claim(authority)!;
    expect(allocation.attempt.runtime.configuration.executablePath).toBe("/fixture/codex");
    expect(store.execution.claim(authority)).toBeNull();
    expect(() => store.execution.configure({ expected_revision: 1, configuration: { provider: "codex", executablePath: "/other" } })).toThrow(/Stop Admin/);
    const id = "stop";
    const stop = store.execution.setIntent({ intent: "stopped", request_id: id });
    expect(store.execution.setIntent({ intent: "stopped", request_id: id })).toEqual(stop);
    expect(() => store.execution.setIntent({ intent: "running", request_id: id })).toThrow(/rewritten/);
    expect(() => store.execution.command(allocation.claim, { action: "status" })).toThrow(/identity, intent or generation/);
});
it("holds uncertain physical ownership across supervisor replacement and releases only the exact confirmed process", () => {
    const { authority, first, second } = setup(), allocated = store.execution.claim(authority)!;
    expect(allocated.claim.caseId).toBe(first.caseId);
    store.execution.bind(allocated.claim, { pid: 42, marker: "birth-one", group_id: 42 });
    expect(store.execution.finish(allocated.claim, { exit_confirmed: false, reason: "Original process cleanup is uncertain" })).toEqual({ settled: false });
    expect(store.execution.claim(authority)).toBeNull();
    now += 30001;
    const successor = store.acquireSupervisor("successor", 30000, true)!;
    expect(store.execution.claim(successor)).toBeNull();
    expect(() => store.execution.command(allocated.claim, { action: "status" })).toThrow(/supervision authority/);
    expect(store.execution.retire(successor, { attempt_id: allocated.claim.attemptId, exit_confirmed: false, pid: 42, marker: "birth-one", reason: "Still alive" })).toEqual({ retired: false });
    expect(() => store.execution.retire(successor, { attempt_id: allocated.claim.attemptId, exit_confirmed: true, pid: 42, marker: "reused-pid", reason: "Wrong identity" })).toThrow(/another process/);
    expect(store.execution.retire(successor, { attempt_id: allocated.claim.attemptId, exit_confirmed: true, pid: 42, marker: "birth-one", reason: "Confirmed old process exit" })).toEqual({ retired: true });
    expect(store.execution.claim(successor)!.claim.caseId).toBe(second.caseId);
});
it("lets only the original live owner retire a launch known to have spawned no process", () => {
    const { authority } = setup(), allocated = store.execution.claim(authority)!;
    store.execution.setIntent({ intent: "stopped", request_id: "stop-before-spawn" });
    const proof = { attempt_id: allocated.claim.attemptId, exit_confirmed: true, pid: 0, marker: "", reason: "Known owned pre-spawn failure" };
    expect(() => store.execution.retire(authority, proof)).toThrow(/another process/);
    expect(store.execution.retire(authority, { ...proof, owned_launch: true })).toEqual({ retired: true });
    store.execution.setIntent({ intent: "running", request_id: "start-again" });
    const unknown = store.execution.claim(authority)!;
    now += 30001;
    const successor = store.acquireSupervisor("replacement", 30000, true)!;
    expect(() => store.execution.retire(successor, { ...proof, attempt_id: unknown.claim.attemptId, owned_launch: true })).toThrow(/another process/);
    expect(store.execution.claim(successor)).toBeNull();
});
it("requires status, retains immutable evidence and terminal submissions, and never treats a summary or exit as verification", () => {
    const { authority } = setup(), allocated = store.execution.claim(authority)!;
    store.execution.bind(allocated.claim, { pid: 42, marker: "birth", group_id: 42 });
    const evidence = { action: "evidence", key: "investigated", kind: "finding", payload: { file: "README.md", observation: "Original facts differ" } };
    expect(() => store.execution.command(allocated.claim, evidence)).toThrow(/Read Admin status/);
    expect(store.execution.command(allocated.claim, { action: "status" })).toMatchObject({ agent_action: "investigate" });
    expect(store.execution.command(allocated.claim, evidence)).toEqual({ recorded: true });
    expect(store.execution.command(allocated.claim, evidence)).toEqual({ recorded: true });
    expect(() => store.execution.command(allocated.claim, { ...evidence, payload: { overwritten: true } })).toThrow(/cannot be replaced/);
    const result = { outcome: "deferred", summary: "Original facts retained", nextMethod: "Independent diagnosis required" };
    expect(store.execution.command(allocated.claim, { action: "submit", result })).toEqual({ submitted: true, agent_action: "end_execution" });
    expect(store.execution.command(allocated.claim, { action: "submit", result })).toEqual({ submitted: true, agent_action: "end_execution" });
    expect(() => store.execution.command(allocated.claim, { action: "submit", result: { ...result, summary: "Replace" } })).toThrow(/rewritten/);
    expect(() => store.execution.command(allocated.claim, { ...evidence, key: "late" })).toThrow(/already submitted/);
    expect(store.execution.finish(allocated.claim, { exit_confirmed: true, reason: "Actual native process ended" })).toEqual({ settled: true });
    expect(store.issue(workspaceId, issueId)).toMatchObject({ status: "queued", desired_intent: "running" });
    expect(store.execution.claim(authority)!.attempt.status).toBe("launching");
});
it("pins history chunks and refuses unsupported verification or external-wait shortcuts", () => {
    const { authority } = setup(), allocated = store.execution.claim(authority)!;
    const status = store.execution.command(allocated.claim, { action: "status" });
    if (!("history" in status) || !status.history)
        throw new Error("Missing status history");
    const observations = status.history.observations;
    if (!observations)
        throw new Error("Missing observation history");
    const row = observations.rows[0]!;
    expect(store.execution.command(allocated.claim, { action: "history", collection: "observations", index: 0, start: 0, length: 100, hash: row.hash })).toMatchObject({ hash: row.hash });
    expect(() => store.execution.command(allocated.claim, { action: "history", collection: "observations", index: 0, start: 0, length: 100, hash: "wrong" })).toThrow(/row changed/);
    const verification = { reproductionCommand: "fixture repro", versionCheckCommand: "fixture version", acceptanceChecks: [{ targetRef: "original", command: "fixture verify", expected: "Original oracle" }] };
    expect(() => store.execution.command(allocated.claim, { action: "submit", result: { outcome: "verification-requested", summary: "Do not bypass", repairVersion: "unverified", originalObservationIds: ["original"], repairEvidenceKeys: ["claim"], verification } })).toThrow(/workspace takeover/);
    expect(() => store.execution.command(allocated.claim, { action: "submit", result: { outcome: "external-wait-requested", summary: "Do not escalate Agent failure", dependency: "missing", diagnosisAttemptId: "invented", baselineVersion: "original", originalObservationIds: ["original"], evidenceKey: "claim", retryAfterMs: 30000 } })).toThrow(/independent diagnosis/);
});
