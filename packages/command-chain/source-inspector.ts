import {z} from "zod";
import {inspectNativeSource} from "../../scripts/migration/loopwork-source-inspection.mjs";
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const request=z.strictObject({action:z.literal("inspect"),expected_hash:hash,record:z.strictObject({id:z.uuid(),archive_hash:hash,scope_hash:hash,source_namespace:hash,payload:z.unknown()})});
export function inspectSource(archive:string,input:unknown){return inspectNativeSource(archive,request.parse(input));}
