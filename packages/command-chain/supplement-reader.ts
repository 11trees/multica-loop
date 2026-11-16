import {z} from "zod";
import {browseHistorySupplement} from "../../scripts/migration/loopwork-history-supplement.mjs";
const hash=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().min(1).max(500),scope={expected_archive_hash:hash,expected_hash:hash};
const request=z.discriminatedUnion("action",[
 z.strictObject({action:z.literal("catalog"),...scope}),
 z.strictObject({action:z.literal("tasks"),...scope,database_id:hash,search:z.string().max(200).optional(),offset:z.number().int().min(0).max(1000000).default(0)}),
 z.strictObject({action:z.literal("task"),...scope,database_id:hash,task_id:text}),
 z.strictObject({action:z.literal("document"),...scope,database_id:hash,task_id:text,document_id:text}),
 z.strictObject({action:z.literal("file"),...scope,file_id:hash,offset:z.number().int().nonnegative().max(268435456).default(0),length:z.number().int().positive().max(1048576).default(65536)}),
]);
export function readSupplement(directory:string,input:unknown){return browseHistorySupplement(directory,request.parse(input));}
