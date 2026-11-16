// @vitest-environment node
import {expect,it,vi} from "vitest";
const read=vi.hoisted(()=>vi.fn());vi.mock("../../scripts/migration/loopwork-history-supplement.mjs",()=>({browseHistorySupplement:read}));
import {readSupplement} from "./supplement-reader";
it("only reads pinned supplemental identities and bounded ranges without caller paths or mutators",()=>{
 const scope={expected_archive_hash:"a".repeat(64),expected_hash:"b".repeat(64)};read.mockReturnValue({historical_only:true});
 expect(readSupplement("/configured/supplement",{...scope,action:"file",file_id:"c".repeat(64)})).toEqual({historical_only:true});expect(read).toHaveBeenCalledWith("/configured/supplement",{...scope,action:"file",file_id:"c".repeat(64),offset:0,length:65536});
 for(const bad of [{...scope,action:"capture"},{...scope,action:"catalog",path:"/caller"},{...scope,action:"file",file_id:"../private"},{...scope,action:"file",file_id:"c".repeat(64),length:1048577},{...scope,action:"task",database_id:"c".repeat(64),task_id:"old",actor:{token:"secret"}}])expect(()=>readSupplement("/configured/supplement",bad)).toThrow();
 expect(read).toHaveBeenCalledTimes(1);
});
