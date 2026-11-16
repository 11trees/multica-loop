import {z} from "zod";
import {browseArchive} from "../../scripts/migration/loopwork-history-lib.mjs";
const text=z.string().min(1).max(500);
const request=z.discriminatedUnion("action",[
 z.strictObject({action:z.literal("list"),expected_hash:z.string().regex(/^[a-f0-9]{64}$/),project_id:text.optional(),search:z.string().max(200).optional(),offset:z.number().int().min(0).max(1000000).default(0)}),
 z.strictObject({action:z.literal("task"),expected_hash:z.string().regex(/^[a-f0-9]{64}$/),task_id:text}),
 z.strictObject({action:z.literal("document"),expected_hash:z.string().regex(/^[a-f0-9]{64}$/),task_id:text,document_id:text}),
 z.strictObject({action:z.literal("packet"),expected_hash:z.string().regex(/^[a-f0-9]{64}$/),task_id:text}),
]);
export function readHistory(archive:string,input:unknown){const value=request.parse(input);return browseArchive(archive,value.expected_hash,value);}
