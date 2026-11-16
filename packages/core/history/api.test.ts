// @vitest-environment node
import {afterEach,expect,it,vi} from "vitest";
import {ApiClient} from "../api/client";
import {historyKeys} from "./queries";
const source={hash:"a".repeat(64),commit:"original-source",captured_at:"2026-11-17T00:00:00Z",name:"LoopWork"};
afterEach(()=>vi.unstubAllGlobals());
it("pins request workspace, encodes original non-UUID IDs and rejects an unproven historical response",async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({historical_only:true,source,document:null}),{status:200}));vi.stubGlobal("fetch",fetch);const client=new ApiClient("https://history.test");
 expect(await client.historyDocument("local-workspace","原任务/1","原报告#2")).toMatchObject({document:null});
 expect(fetch.mock.calls[0]![0]).toContain(`/tasks/${encodeURIComponent("原任务/1")}/documents/${encodeURIComponent("原报告#2")}`);
 const headers=new Headers(fetch.mock.calls[0]![1]?.headers);expect(headers.get("X-Workspace-ID")).toBe("local-workspace");expect(headers.get("X-Workspace-Slug")).toBe("");
 fetch.mockResolvedValue(new Response(JSON.stringify({historical_only:false,source,task:null,documents:[]}),{status:200}));await expect(client.historyTask("local-workspace","original")).rejects.toThrow(/Invalid historical/);
 fetch.mockResolvedValue(new Response(JSON.stringify({enabled:"yes"}),{status:200}));expect(await client.historyAvailability("local-workspace")).toEqual({enabled:false});
 expect(historyKeys.all("workspace-a","user-a")).not.toEqual(historyKeys.all("workspace-b","user-a"));expect(historyKeys.all("workspace-a","user-a")).not.toEqual(historyKeys.all("workspace-a","user-b"));
});
