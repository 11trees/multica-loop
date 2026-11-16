// @vitest-environment node
import {it,expect} from "vitest";
import {sampleRepairDispatchWatch,repairDispatchStallDue,REPAIR_DISPATCH_STALL_MS,REPAIR_DISPATCH_SAMPLE_MAX_GAP_MS,type RepairReadiness} from "./repair-watch";
it("requires a fresh continuous eligible interval for one exact dispatch and run intent",()=>{
 let watch=sampleRepairDispatchWatch(undefined,"runnable",0,1,"source");for(let now=60000;now<=REPAIR_DISPATCH_STALL_MS;now+=60000)watch=sampleRepairDispatchWatch(watch,"runnable",now,1,"source");
 expect(repairDispatchStallDue(watch,REPAIR_DISPATCH_STALL_MS,1,"source")).toBe(true);expect(repairDispatchStallDue(watch,REPAIR_DISPATCH_STALL_MS+REPAIR_DISPATCH_SAMPLE_MAX_GAP_MS+1,1,"source")).toBe(false);expect(repairDispatchStallDue(watch,REPAIR_DISPATCH_STALL_MS,2,"source")).toBe(false);expect(repairDispatchStallDue(watch,REPAIR_DISPATCH_STALL_MS,1,"new-source")).toBe(false);
});
it.each(["executing","waiting","paused","ended","source-changed","failed"] as RepairReadiness[])("does not count %s as eligible dispatch time",readiness=>{
 const prior={intentRevision:1,sourceKey:"source",readiness:"runnable" as const,eligibleElapsedMs:REPAIR_DISPATCH_STALL_MS,lastSampleAt:100000};const changed=sampleRepairDispatchWatch(prior,readiness,110000,1,"source");expect(changed.eligibleElapsedMs).toBe(0);expect(sampleRepairDispatchWatch(changed,"runnable",120000,1,"source").eligibleElapsedMs).toBe(0);
});
it("resets on host outage, clock rollback, intent changes and a changed source instead of joining unrelated intervals",()=>{
 const prior={intentRevision:1,sourceKey:"source",readiness:"runnable" as const,eligibleElapsedMs:REPAIR_DISPATCH_STALL_MS,lastSampleAt:200000};
 for(const [now,revision,source]of [[199999,1,"source"],[200001,2,"source"],[200001,1,"new-source"],[200000+REPAIR_DISPATCH_SAMPLE_MAX_GAP_MS+1,1,"source"]]as const)expect(sampleRepairDispatchWatch(prior,"runnable",now,revision,source).eligibleElapsedMs).toBe(0);
});
