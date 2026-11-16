// @vitest-environment node
import {afterEach,expect,it,vi} from "vitest";
import {ApiClient} from "../api/client";
import {historyKeys,supplementOptions} from "./queries";
import {HistoryPacketSchema,historyPacketTables,HistoryPreparationSchema,HistoryAdoptionSchema} from "./schema";
const source={hash:"a".repeat(64),commit:"original-source",captured_at:"2026-11-17T00:00:00Z",name:"LoopWork"};
afterEach(()=>vi.unstubAllGlobals());
it("pins request workspace, encodes original non-UUID IDs and rejects an unproven historical response",async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({historical_only:true,source,document:null}),{status:200}));vi.stubGlobal("fetch",fetch);const client=new ApiClient("https://history.test");
 expect(await client.historyDocument("local-workspace","原任务/1","原报告#2")).toMatchObject({document:null});
 expect(fetch.mock.calls[0]![0]).toContain(`/tasks/${encodeURIComponent("原任务/1")}/documents/${encodeURIComponent("原报告#2")}`);
 const headers=new Headers(fetch.mock.calls[0]![1]?.headers);expect(headers.get("X-Workspace-ID")).toBe("local-workspace");expect(headers.get("X-Workspace-Slug")).toBe("");
 fetch.mockResolvedValue(new Response(JSON.stringify({historical_only:false,source,task:null,documents:[]}),{status:200}));await expect(client.historyTask("local-workspace","original")).rejects.toThrow(/Invalid historical/);
 fetch.mockResolvedValue(new Response(JSON.stringify({enabled:"yes"}),{status:200}));expect(await client.historyAvailability("local-workspace")).toEqual({enabled:false,supplement:{enabled:false,hash:""}});
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

it("activates only the explicitly reviewed scope and workspace without accepting a started run",async()=>{
 const uuid="11111111-1111-4111-8111-111111111111",input={expectedScopeHash:"a".repeat(64),expectedWorkspaceHash:"b".repeat(64),executionMode:"in_place" as const};
 const receipt={format:"loopwork-native-activation-v1",cutover_id:uuid,scope_hash:input.expectedScopeHash,workspace_hash:input.expectedWorkspaceHash,activated_by:uuid,activated_at:"2026-11-17T00:00:00Z",execution_mode:"in_place",execution_started:false,source_inspection:{},tasks:[{cutover_id:uuid,preparation_id:uuid,source_task_id:"source-task",issue_id:uuid,identifier:"LOOP-9",phase:"activated",team_id:uuid,team_revision:1,execution_authorized:false}],resources:[{id:uuid,project_id:uuid,resource_ref:{local_path:"/current/fixture",daemon_id:uuid,execution_mode:"in_place"}}],roles:[{agent_id:uuid,runtime_id:uuid,daemon_id:uuid}]};
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt),{status:200}));vi.stubGlobal("fetch",fetch);const client=new ApiClient("https://history.test");
 expect(await client.activateHistoryCutover("workspace",uuid,input)).toMatchObject({workspaceHash:input.expectedWorkspaceHash,executionStarted:false});
 expect(JSON.parse(fetch.mock.calls[0]![1]?.body)).toEqual({expected_scope_hash:input.expectedScopeHash,expected_workspace_hash:input.expectedWorkspaceHash,execution_mode:"in_place"});expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("X-Workspace-ID")).toBe("workspace");
 for(const bad of [{...receipt,workspace_hash:"c".repeat(64)},{...receipt,execution_started:true},{...receipt,tasks:[{...receipt.tasks[0],execution_authorized:true}]},{...receipt,resources:[]}]){fetch.mockResolvedValue(new Response(JSON.stringify(bad),{status:200}));await expect(client.activateHistoryCutover("workspace",uuid,input)).rejects.toThrow(/Invalid migration activation/);}
 expect(HistoryAdoptionSchema.parse({cutover_id:uuid,preparation_id:uuid,issue_id:uuid,identifier:"LOOP-9",phase:"activated",execution_authorized:false}).phase).toBe("activated");
});

it("keeps supplemental database identity in requests and validates original download bytes",async()=>{
 const hash="a".repeat(64),database="b".repeat(64),fileID="c".repeat(64),bytes=new Uint8Array([0,1,255,2]),sha=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(v=>v.toString(16).padStart(2,"0")).join("");
 const envelope={historical_only:true,execution_authorized:false,hash,archive_hash:"d".repeat(64)},file={id:fileID,path:"original/PROMPT.md",category:"generated_prompt_memory_history",bytes:4,sha256:sha,origin:{agent_id:"original-agent"}},chunk={...envelope,file,offset:0,byte_length:4,data_base64:btoa(String.fromCharCode(...bytes)),eof:true};
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(chunk),{status:200}));vi.stubGlobal("fetch",fetch);const client=new ApiClient("https://history.test");expect(await client.downloadHistorySupplementFile("workspace",hash,fileID)).toEqual(bytes);expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("X-Workspace-ID")).toBe("workspace");
 for(const invalid of [{...chunk,hash:"e".repeat(64)},{...chunk,execution_authorized:true},{...chunk,file:{...file,id:"e".repeat(64)}},{...chunk,byte_length:3},{...chunk,data_base64:"!not-base64"}]){fetch.mockResolvedValue(new Response(JSON.stringify(invalid),{status:200}));await expect(client.historySupplement("workspace",hash,{action:"file",fileId:fileID})).rejects.toThrow();}
 fetch.mockResolvedValue(new Response(JSON.stringify({...chunk,file:{...file,sha256:"0".repeat(64)}}),{status:200}));await expect(client.downloadHistorySupplementFile("workspace",hash,fileID)).rejects.toThrow(/fingerprint/);
 fetch.mockImplementation(async()=>new Response(JSON.stringify({...envelope,database:{id:database,path:"old/one.db",kind:"historical_business_database",available:true,task_count:0,additional_task_count:0},tasks:[],total:0,offset:0,limit:50}),{status:200}));await client.historySupplement("workspace",hash,{action:"tasks",databaseId:database});expect(fetch.mock.lastCall![0]).toContain(`/databases/${database}/tasks`);
 await expect(client.historySupplement("workspace",hash,{action:"tasks",databaseId:"e".repeat(64)})).rejects.toThrow(/supplement/);
});

it("downloads multiple bounded chunks and accepts zero-byte original files",async()=>{
 const hash="a".repeat(64),id="b".repeat(64),bytes=new Uint8Array(1048580).fill(97),sha=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(v=>v.toString(16).padStart(2,"0")).join("");
 const fetch=vi.fn().mockImplementation(async(url:string)=>{const offset=Number(new URL(url).searchParams.get('offset')),part=bytes.slice(offset,offset+1048576);return new Response(JSON.stringify({historical_only:true,execution_authorized:false,archive_hash:"c".repeat(64),hash,file:{id,path:"admin/host.log",bytes:bytes.length,sha256:sha,category:"management_host_log",origin:{}},offset,byte_length:part.length,data_base64:Buffer.from(part).toString('base64'),eof:offset+part.length===bytes.length}),{status:200});});vi.stubGlobal("fetch",fetch);
 const client=new ApiClient("https://history.test");expect(await client.downloadHistorySupplementFile("workspace",hash,id)).toEqual(bytes);expect(fetch).toHaveBeenCalledTimes(2);
 const emptySha="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
 fetch.mockResolvedValue(new Response(JSON.stringify({historical_only:true,execution_authorized:false,archive_hash:"c".repeat(64),hash,file:{id,path:"run/stderr.log",bytes:0,sha256:emptySha,category:"run_diagnostics",origin:{}},offset:0,byte_length:0,data_base64:"",eof:true}),{status:200}));expect(await client.downloadHistorySupplementFile("workspace",hash,id)).toEqual(new Uint8Array(0));
});

it("separates same-ID backup records by database, archive, workspace and human in the cache",()=>{
 const input={action:"task" as const,databaseId:"a".repeat(64),taskId:"same"},key=supplementOptions("workspace","owner","b".repeat(64),input).queryKey;
 for(const other of [supplementOptions("other","owner","b".repeat(64),input).queryKey,supplementOptions("workspace","other","b".repeat(64),input).queryKey,supplementOptions("workspace","owner","c".repeat(64),input).queryKey,supplementOptions("workspace","owner","b".repeat(64),{...input,databaseId:"d".repeat(64)}).queryKey])expect(key).not.toEqual(other);
});
