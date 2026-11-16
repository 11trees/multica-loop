// @vitest-environment node
import {expect,it,vi} from "vitest";
const reader=vi.hoisted(()=>vi.fn());
vi.mock("../../scripts/migration/loopwork-source-inspection.mjs",()=>({inspectNativeSource:reader}));
import {inspectSource} from "./source-inspector";
it("exposes only the pinned native inspection request without source paths, actor tokens or mutators",()=>{
 const input={action:"inspect",expected_hash:"a".repeat(64),record:{id:"11111111-1111-4111-8111-111111111111",archive_hash:"a".repeat(64),scope_hash:"b".repeat(64),source_namespace:"c".repeat(64),payload:{format:"loopwork-cutover-hold-v1"}}};
 reader.mockReturnValue({source_frozen:true});expect(inspectSource("/host/pinned-archive",input)).toEqual({source_frozen:true});expect(reader).toHaveBeenCalledWith("/host/pinned-archive",input);
 for(const bad of [{...input,action:"freeze"},{...input,source_path:"/caller/path"},{...input,actor:{token:"caller-secret"}},{...input,record:{...input.record,path:"/other"}}])expect(()=>inspectSource("/host/pinned-archive",bad)).toThrow();
 expect(reader).toHaveBeenCalledTimes(1);
});
