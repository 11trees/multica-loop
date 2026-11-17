import {act, cleanup, render, waitFor} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";

const mocks = vi.hoisted(() => ({report: vi.fn(), installId: vi.fn()}));
vi.mock("@multica/core/api", () => ({api: {upsertClientUsage: mocks.report}}));
vi.mock("@multica/core/auth", () => ({
  useAuthStore: (select: (state: {user: {id: string}}) => unknown) => select({user: {id: "local-user"}}),
}));
vi.mock("@multica/core/client-usage", () => ({getOrCreateInstallId: mocks.installId, utcDay: () => "2026-11-17"}));
import {DesktopClientUsageReporter} from "./client-usage-reporter";

afterEach(() => {cleanup(); vi.restoreAllMocks();});

it("does not discover providers or report an empty inventory on login, focus or stopped status", async () => {
  mocks.report.mockClear(); mocks.installId.mockClear();
  let statusChanged: ((status: {state: string}) => void) | undefined;
  const getStatus = vi.fn().mockResolvedValue({state: "stopped"});
  const probeRuntimes = vi.fn();
  const previous = Object.getOwnPropertyDescriptor(window, "daemonAPI");
  Object.defineProperty(window, "daemonAPI", {configurable: true, value: {
    setTargetApiUrl: vi.fn().mockResolvedValue(undefined), getStatus, probeRuntimes,
    onStatusChange: (handler: typeof statusChanged) => {statusChanged = handler; return () => {};},
  }});
  try {
    render(<DesktopClientUsageReporter apiUrl="http://localhost:18729"/>);
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));
    await act(async () => {window.dispatchEvent(new Event("focus"));});
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
    await act(async () => {statusChanged?.({state: "stopped"});});
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(3));
    expect(probeRuntimes).not.toHaveBeenCalled();
    expect(mocks.installId).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  } finally {
    cleanup();
    if (previous) Object.defineProperty(window, "daemonAPI", previous);
    else Reflect.deleteProperty(window, "daemonAPI");
  }
});
