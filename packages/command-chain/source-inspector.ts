import {z} from "zod";
import {inspectNativeSource} from "../../scripts/migration/loopwork-source-inspection.mjs";
import {inspectActivationWorkspaces} from "../../scripts/migration/loopwork-workspace-inspection.mjs";
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const scope={expected_hash:hash,record:z.strictObject({id:z.uuid(),archive_hash:hash,scope_hash:hash,source_namespace:hash,payload:z.unknown()})};
const request=z.discriminatedUnion("action",[
 z.strictObject({action:z.literal("inspect"),...scope}),
 z.strictObject({action:z.literal("workspace-check"),...scope,expected_workspace_hash:hash,workspace_observation:z.unknown()}),
]);
export function inspectSource(archive:string,input:unknown){const value=request.parse(input);return value.action==="inspect"?inspectNativeSource(archive,value):inspectActivationWorkspaces(archive,value);}
