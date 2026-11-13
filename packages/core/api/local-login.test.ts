// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { AppConfigSchema } from "./schemas";

afterEach(() => vi.unstubAllGlobals());

describe("local authentication API", () => {
  it("only enables local bootstrap on an explicit boolean capability", () => {
    for (const input of [{}, { local_auth_enabled: "true" }, { local_auth_enabled: 1 }]) {
      expect(AppConfigSchema.parse(input).local_auth_enabled).toBe(false);
    }
    expect(AppConfigSchema.parse({ local_auth_enabled: true }).local_auth_enabled).toBe(true);
  });

  it("accepts a local session and rejects malformed credentials", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const api = new ApiClient("http://localhost:8080");
    const user = { id: "db20ef47-8076-41a0-af0d-2814950fbe42", email: "local@multica-loop.invalid" };
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ token: "local-test-token", user })));
    expect((await api.localLogin()).user.id).toBe(user.id);
    for (const malformed of [{ user }, { token: "", user }, { token: "test", user: {} }]) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify(malformed)));
      await expect(api.localLogin()).rejects.toThrow(/Malformed response/);
    }
  });
});
