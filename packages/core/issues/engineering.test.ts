// @vitest-environment node
import { expect, it } from "vitest";
import { engineeringOverviewOptions } from "./engineering";

function poll(data: unknown) {
  const interval = engineeringOverviewOptions("workspace", "issue").refetchInterval;
  if (typeof interval !== "function")
    throw new Error("Expected engineering polling policy");
  return interval({ state: { data } } as Parameters<typeof interval>[0]);
}

type Review = { acknowledgement: unknown; result: { verdict: string } };

function completedTeam(workflow = "bug_fix") {
  return {
    configured: true,
    status: "completed",
    hasActiveRun: false,
    team: { frozen: true, workflow },
    requirement: {
      end_to_end: false,
      review: null as Review | null,
      delivery_policy: {},
      publication: { units: [{ unit: { key: "continue" } }] },
      accepted: { continue: {} },
    },
  };
}

it.each(["develop", "bug_fix"])("keeps the %s Team observable between unit acceptance and automatic final review", workflow => {
  expect(poll(completedTeam(workflow))).toBe(5000);
});
it("keeps an unread Team report observable after its native run finishes", () => {
  const state = completedTeam();
  state.requirement.review = { acknowledgement: null, result: { verdict: "report_ready" } };
  expect(poll(state)).toBe(5000);
});
it("stops normal Team polling once the current report is acknowledged", () => {
  const state = completedTeam();
  state.requirement.review = { acknowledgement: { reportHash: "current" }, result: { verdict: "report_ready" } };
  expect(poll(state)).toBe(false);
});
it("does not keep polling an abandoned Team draft without a runnable continuation", () => {
  const state = completedTeam();
  state.status = "abandoned";
  expect(poll(state)).toBe(false);
});
it("preserves the manual final-review boundary for a completed standalone requirement", () => {
  const { team: _, ...state } = completedTeam();
  expect(poll(state)).toBe(false);
});
