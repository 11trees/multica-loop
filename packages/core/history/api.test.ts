// @vitest-environment node
import {afterEach,expect,it,vi} from "vitest";
import {ApiClient} from "../api/client";
import {historyKeys} from "./queries";
import {HistoryPacketSchema,historyPacketTables,HistoryPreparationSchema,HistoryAdoptionSchema} from "./schema";
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
it("prepares only an explicitly scoped source version and rejects execution authority in the response",async()=>{
 const uuid='11111111-1111-4111-8111-111111111111',saved={id:uuid,revision:1,archive_hash:'a'.repeat(64),packet_hash:'b'.repeat(64),project_id:uuid,team_id:uuid,team_revision:2,prepared_by:uuid,created_at:'2026-11-17T00:00:00Z',current:true,source_owner:'LoopWork',execution_authorized:false};
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(saved),{status:200}));vi.stubGlobal('fetch',fetch);const client=new ApiClient('https://history.test'),input={expectedRevision:0,expectedPacketHash:saved.packet_hash,teamId:uuid,expectedTeamRevision:2,createProject:true};
 expect(await client.prepareHistoryTask('workspace','source/task',input)).toMatchObject({revision:1,teamRevision:2,executionAuthorized:false});expect(fetch.mock.calls[0]![0]).toContain('/tasks/source%2Ftask/preparation');expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('X-Workspace-ID')).toBe('workspace');expect(JSON.parse(fetch.mock.calls[0]![1]?.body)).toEqual({expected_revision:0,expected_packet_hash:saved.packet_hash,team_id:uuid,expected_team_revision:2,create_project:true});
 const state={source_owner:'LoopWork',execution_authorized:false,source_task_id:'source/task',packet_hash:saved.packet_hash,archive_hash:saved.archive_hash,mapped_project_id:uuid,projects:[{id:uuid,title:'Original project'}],teams:[{id:uuid,name:'Development',revision:2,workflow:'develop'}],blockers:[],preparations:[saved]};
 expect(HistoryPreparationSchema.safeParse(state).success).toBe(true);expect(HistoryPreparationSchema.safeParse({...state,preparations:[{...saved,created_at:'2026-11-17T08:00:00+08:00'}]}).success).toBe(true);for(const bad of [{...state,execution_authorized:true},{...state,source_owner:'Multica'},{...state,preparations:[{...saved,team_revision:0}]},{...state,mapped_project_id:'unscoped project'}])expect(HistoryPreparationSchema.safeParse(bad).success).toBe(false);
 fetch.mockResolvedValue(new Response(JSON.stringify({...saved,packet_hash:'c'.repeat(64)}),{status:200}));await expect(client.prepareHistoryTask('workspace','source/task',input)).rejects.toThrow(/Invalid saved migration/);
});
it("validates frozen material coverage and source ownership before exposing a package",async()=>{
 const packet={format:"loopwork-task-handoff-v1",hash:"b".repeat(64),source,source_task_id:"original/task",source_project:{id:"project",name:"Original",workspace_root:"/source",deleted_at:null},source_task_terminal:false,schema_complete:true,sections:[{table:"acceptances",status:"included",columns:["revision","statement"],missing_columns:[],omitted_columns:[],rows:[{revision:{sqlite_integer:"9223372036854775807"},statement:"Exact original obligation"}]}],ownership:{source_owner:"LoopWork",native_execution_authorized:false},exclusions:["External files are not migrated"]};
 packet.sections.push(...historyPacketTables.filter(table=>table!=='acceptances').map(table=>({table,status:'included',columns:[],missing_columns:[],omitted_columns:[],rows:[]})));
 const body={historical_only:true,source,packet},fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status:200}));vi.stubGlobal("fetch",fetch);const client=new ApiClient("https://history.test");
 expect((await client.historyPacket("workspace","original/task")).packet?.sections[0]?.rows[0]?.revision).toEqual({sqlite_integer:"9223372036854775807"});expect(fetch.mock.calls[0]![0]).toContain('/tasks/original%2Ftask/packet');expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('X-Workspace-ID')).toBe('workspace');
 for(const invalid of [
  {...packet,hash:'bad'}, {...packet,source:{...source,hash:'c'.repeat(64)}}, {...packet,ownership:{...packet.ownership,native_execution_authorized:true}}, {...packet,schema_complete:false}, {...packet,sections:[{...packet.sections[0],rows:[{revision:'missing original statement'}]},...packet.sections.slice(1)]}, {...packet,sections:[{...packet.sections[0],status:'unavailable'},...packet.sections.slice(1)]}, {...packet,sections:[packet.sections[0],packet.sections[0],...packet.sections.slice(2)]}, {...packet,sections:packet.sections.slice(1)},
 ])expect(HistoryPacketSchema.safeParse({...body,packet:invalid}).success).toBe(false);
 fetch.mockResolvedValue(new Response(JSON.stringify({...body,packet:{...packet,source_task_id:'other-task'}}),{status:200}));await expect(client.historyPacket('workspace','original/task')).rejects.toThrow(/Invalid historical packet/);
});

it("keeps native task correspondence inert and accepts older history responses without correspondence",()=>{
 const uuid="11111111-1111-4111-8111-111111111111",row={cutover_id:uuid,preparation_id:uuid,issue_id:uuid,identifier:"LOOP-9",phase:"staged",native_available:true,execution_authorized:false};
 expect(HistoryAdoptionSchema.parse(row)).toMatchObject({issueId:uuid,phase:"staged",nativeAvailable:true,executionAuthorized:false});
 expect(HistoryAdoptionSchema.parse({...row,phase:"future"}).phase).toBe("unknown");
 for(const bad of [{...row,execution_authorized:true},{...row,issue_id:"unscoped"}])expect(HistoryAdoptionSchema.safeParse(bad).success).toBe(false);
});
