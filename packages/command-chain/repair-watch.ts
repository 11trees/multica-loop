import {z} from "zod";

export const REPAIR_DISPATCH_SAMPLE_MAX_GAP_MS=120000;
export const REPAIR_DISPATCH_STALL_MS=20*60*1000;
export const repairReadinessSchema=z.enum(["runnable","executing","waiting","paused","ended","source-changed","failed"]);
export type RepairReadiness=z.infer<typeof repairReadinessSchema>;
export const repairDispatchWatchSchema=z.strictObject({intentRevision:z.number().int().nonnegative(),sourceKey:z.string().min(1),readiness:repairReadinessSchema,eligibleElapsedMs:z.number().int().nonnegative(),lastSampleAt:z.number().int().nonnegative()});
export type RepairDispatchWatch=z.infer<typeof repairDispatchWatchSchema>;
function currentSample(w:RepairDispatchWatch,now:number,intentRevision:number,sourceKey:string){const delta=now-w.lastSampleAt;return Number.isSafeInteger(w.lastSampleAt)&&w.lastSampleAt>=0&&Number.isSafeInteger(w.eligibleElapsedMs)&&w.eligibleElapsedMs>=0&&w.intentRevision===intentRevision&&w.sourceKey===sourceKey&&delta>=0&&delta<=REPAIR_DISPATCH_SAMPLE_MAX_GAP_MS;}
/** Only adjacent observations for the same dispatch and run intent count. */
export function sampleRepairDispatchWatch(prior:RepairDispatchWatch|undefined,readiness:RepairReadiness,now:number,intentRevision:number,sourceKey:string):RepairDispatchWatch{
 if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(intentRevision)||intentRevision<0||!sourceKey)throw new Error("Recovery observation requires a valid host clock, intent and source");
 const continuous=prior&&readiness==="runnable"&&prior.readiness==="runnable"&&currentSample(prior,now,intentRevision,sourceKey);
 return {intentRevision,sourceKey,readiness,lastSampleAt:now,eligibleElapsedMs:continuous?prior.eligibleElapsedMs+now-prior.lastSampleAt:0};
}
export function repairDispatchStallDue(w:RepairDispatchWatch|undefined,now:number,intentRevision:number,sourceKey:string){return !!(w&&Number.isSafeInteger(now)&&now>=0&&w.readiness==="runnable"&&currentSample(w,now,intentRevision,sourceKey)&&w.eligibleElapsedMs>=REPAIR_DISPATCH_STALL_MS);}
