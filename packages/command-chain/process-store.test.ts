// @vitest-environment node
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { EngineeringProcessStore } from "./process-store";
const owner = () => ({ workspaceId: randomUUID(), issueId: randomUUID(), agentId: randomUUID(), attemptId: randomUUID() });
const identity = () => ({ allocation_id: randomUUID(), runtime_id: randomUUID(), host_id: "fixture-boot" });
it("requires immutable native repository binding and keeps unbound launches across native claim replacement", () => {
    const db = new DatabaseSync(":memory:"), store = new EngineeringProcessStore(db), scope = owner(), id = identity();
    try {
        expect(() => store.invoke(scope, { ...id, operation: "reserve", provider: "codex" })).toThrow(/Bind the actual/);
        store.bind(scope, undefined, "/fixture/repository", "in_place");
        store.bind(scope, undefined, "/fixture/repository", "in_place");
        expect(() => store.invoke(scope, { ...id, operation: "reserve", provider: "codex" }, false, randomUUID())).toThrow(/project changed/);
        expect(() => store.bind(scope, undefined, "/another/path", "in_place")).toThrow(/cannot change/);
        expect(store.invoke(scope, { ...id, operation: "reserve", provider: "codex" })).toEqual({ reserved: true, status: "launching" });
        const replacement = { ...scope, attemptId: randomUUID() };
        store.bind(replacement, undefined, "/fixture/repository", "in_place");
        expect(() => store.invoke(replacement, { ...identity(), operation: "reserve", provider: "codex" })).toThrow(/physical exit/);
        expect(() => store.assertExited(scope.workspaceId, scope.issueId)).toThrow(/physical exit/);
        expect(store.invoke(scope, { ...id, operation: "exit", pid: 0, exit_confirmed: false })).toEqual({ exited: false });
        expect(store.invoke(scope, { ...id, operation: "exit", pid: 0, exit_confirmed: true })).toEqual({ exited: true });
        expect(() => store.assertExited(scope.workspaceId, scope.issueId)).not.toThrow();
        expect(store.invoke(replacement, { ...identity(), operation: "reserve", provider: "codex" })).toMatchObject({ reserved: true });
    }
    finally {
        db.close();
    }
});
it("binds one exact process birth, permits cleanup after surrender, and rejects stale host/claim mutations", () => {
    const db = new DatabaseSync(":memory:"), store = new EngineeringProcessStore(db), scope = owner(), id = identity();
    try {
        store.bind(scope, undefined, "/fixture/repository", "worktree");
        store.invoke(scope, { ...id, operation: "reserve", provider: "codex" });
        const binding = { ...id, operation: "bind", pid: 42, group_id: 42, marker: "birth-one" };
        expect(store.invoke(scope, binding)).toEqual({ bound: true });
        expect(store.invoke(scope, binding)).toEqual({ bound: true });
        expect(() => store.invoke(scope, { ...binding, marker: "reused" })).toThrow(/cannot be replaced/);
        expect(() => store.invoke({ ...scope, agentId: randomUUID() }, binding)).toThrow(/another native claim/);
        expect(() => store.invoke(scope, { ...binding, host_id: "another-machine" })).toThrow(/another native claim/);
        expect(() => store.invoke(scope, binding, true)).toThrow(/Inactive/);
        expect(() => store.invoke(scope, { ...id, operation: "exit", pid: 99, exit_confirmed: true }, true)).toThrow(/another process/);
        expect(store.invoke(scope, { ...id, operation: "exit", pid: 42, exit_confirmed: false }, true)).toEqual({ exited: false });
        expect(store.invoke(scope, { ...id, operation: "exit", pid: 42, exit_confirmed: true }, true)).toEqual({ exited: true });
        expect(store.invoke(scope, { ...id, operation: "exit", pid: 42, exit_confirmed: true }, true)).toEqual({ exited: true });
        expect(() => store.invoke(scope, { ...id, operation: "exit", pid: 0, exit_confirmed: true }, true)).toThrow(/cannot be rewritten/);
        expect(() => store.invoke(scope, { ...identity(), operation: "reserve", provider: "codex" }, true)).toThrow(/Surrendered/);
        expect(store.scope(scope.workspaceId, scope.issueId).allocations[0]).toMatchObject({ status: "exited", pid: 42, marker: "birth-one", repositoryPath: "/fixture/repository" });
    }
    finally {
        db.close();
    }
});
it("rechecks durable surrender inside process mutation even after the active hold is released", () => {
    const db = new DatabaseSync(":memory:"), store = new EngineeringProcessStore(db), scope = owner(), id = identity();
    try {
        store.bind(scope, undefined, "/fixture/repository", "in_place");
        store.invoke(scope, { ...id, operation: "reserve", provider: "codex" });
        db.prepare("INSERT INTO engineering_intervention VALUES(?,?,?,?,?)").run(scope.workspaceId, scope.issueId, scope.attemptId, null, JSON.stringify({ observationId: "original" }));
        db.prepare("INSERT INTO engineering_repair_dispatch VALUES(?,?,?,?,?,'active',?,?)").run("target", "original", scope.workspaceId, scope.issueId, randomUUID(), "{}", "new-claim");
        expect(db.prepare("SELECT 1 FROM engineering_intervention_pending").get()).toBeUndefined();
        expect(() => store.invoke(scope, { ...id, operation: "bind", pid: 42, group_id: 42, marker: "late-birth" })).toThrow(/Inactive/);
        expect(store.invoke(scope, { ...id, operation: "exit", pid: 0, exit_confirmed: true })).toEqual({ exited: true });
        expect(() => store.invoke(scope, { ...identity(), operation: "reserve", provider: "codex" })).toThrow(/Surrendered/);
    } finally { db.close(); }
});
