// @vitest-environment node
import {randomUUID} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
import {ApiClient} from "./client";
const definition={workflow:"direct" as const,roles:{executor:randomUUID()},decision_mode:"balanced" as const,max_reworks:2};
const profile={workspaceId:randomUUID(),teamId:randomUUID(),revision:1,configuredBy:randomUUID(),definition,createdAt:"2026-11-16T00:00:00.000Z"};
const respond=(body:unknown)=>vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status:200,headers:{"Content-Type":"application/json"}})));
afterEach(()=>vi.unstubAllGlobals());
it("parses Team workflow versions and sends settings only to the Team endpoint",async()=>{
 const client=new ApiClient("https://api.example.test");respond({profile});expect(await client.getEngineeringTeam(profile.teamId)).toEqual({enabled:true,profile});
 respond({profile});expect(await client.saveEngineeringTeam(profile.teamId,0,definition)).toEqual({enabled:true,profile});expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({expected_revision:0,definition});
});
it("does not convert malformed Team profiles or empty save acknowledgements into a configured Team",async()=>{
 const client=new ApiClient("https://api.example.test");
 for(const body of [{profile:{...profile,revision:0}},{profile:{...profile,definition:{...definition,roles:{}}}},{configured:true}]){respond(body);await expect(client.getEngineeringTeam(profile.teamId)).rejects.toThrow(/Malformed/)}
 respond({profile:null});await expect(client.saveEngineeringTeam(profile.teamId,0,definition)).rejects.toThrow(/Malformed/);
 respond({enabled:false,profile:null});expect(await client.getEngineeringTeam(profile.teamId)).toEqual({enabled:false,profile:null});
});

it("starts the selected native Team without accepting per-task settings and rejects an empty acknowledgement",async()=>{
 const client=new ApiClient("https://api.example.test");respond({started:true});await client.startEngineeringTeam("issue");
 expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain("/api/issues/issue/engineering/team-start");
 expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({});
 respond({});await expect(client.startEngineeringTeam("issue")).rejects.toThrow(/Invalid Team start/);
});
