import { expect, it, vi } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { DirectConfigure, DirectPanel } from "./direct";

const listAgents = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/api", async original => ({ ...await original<typeof import("@multica/core/api")>(), api: { listAgents } }));

it("preserves the full original work after a failed Direct configuration and submits only its single role", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), user = userEvent.setup();
  listAgents.mockResolvedValue([{ id: "direct-role", name: "Direct fixture", archived_at: null }]);
  const save = vi.fn().mockRejectedValueOnce(new Error("Repository unavailable")).mockResolvedValue(undefined);
  renderWithI18n(<QueryClientProvider client={client}><DirectConfigure workspaceId="workspace" issue={{ title: "Summarize notes", description: "Preserve the original observations" } as Issue} pending={false} onSave={save} /></QueryClientProvider>);
  await user.click(screen.getByRole("button", { name: "Direct" })); const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByLabelText("Work to execute")).toHaveValue("Summarize notes\n\nPreserve the original observations");
  await user.type(within(dialog).getByLabelText("Repository path"), "/project"); await user.click(within(dialog).getByRole("combobox", { name: "Executing agent" })); await user.click(await screen.findByRole("option", { name: "Direct fixture" }));
  await user.click(within(dialog).getByRole("button", { name: "Start Direct" })); expect(await within(dialog).findByRole("alert")).toHaveTextContent("Repository unavailable");
  await user.click(within(dialog).getByRole("button", { name: "Start Direct" })); await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(save).toHaveBeenLastCalledWith({ expectedRevision: 0, agentId: "direct-role", repositoryPath: "/project", input: "Summarize notes\n\nPreserve the original observations" }); client.clear();
});

it("renders the submitted Markdown as a Direct result and waits for native completion without a reading action", () => {
  renderWithI18n(<DirectPanel direct={{ input: "Summarize existing notes", projectId: "project", contractHash: "a".repeat(64), mode: "in_place", nativeCompleted: false, attempts: [{id:"attempt",active:true,runAt:"2026-11-14T00:00:00.000Z"}],
    result: { id: "result", attemptId: "attempt", summary: "Notes summarized", content: "# Original observations\n\nPreserved the note's exact meaning.", hash: "b".repeat(64), submittedAt: "2026-11-14T00:00:00.000Z" } }} />);
  expect(screen.getByRole("heading", { name: "Direct result" })).toBeVisible(); expect(screen.getByRole("heading", { name: "Original observations" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("waiting for native run completion"); expect(screen.queryByRole("button", { name: /read|close/i })).not.toBeInTheDocument();
});
