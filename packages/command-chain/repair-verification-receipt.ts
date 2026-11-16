import { z } from "zod";
import type { z as Z } from "zod";
import type { preparedRepairPlanSchema } from "./repair-verification-plan";
const text=z.string().min(1),hash=text.regex(/^[a-f0-9]{64}$/);
export type PreparedRepairPlan=Z.infer<typeof preparedRepairPlanSchema>;
export function independentCheckSteps(plan:PreparedRepairPlan){return [
 {kind:"version-before" as const,targetRef:"workspace-version",command:"host:workspace-content-v1"},
 {kind:"reproduction" as const,...plan.reproduction},
 ...plan.acceptanceChecks.map(check=>({kind:"acceptance" as const,...check})),
 {kind:"version-after" as const,targetRef:"workspace-version",command:"host:workspace-content-v1"},
];}
export const independentCheckResultSchema=z.strictObject({exitCode:z.number().int().nullable(),stdout:z.string().max(2*1024*1024),stderr:z.string().max(2*1024*1024),exitConfirmed:z.boolean(),truncated:z.boolean(),scopeConfirmed:z.boolean(),artifactsUnchanged:z.boolean(),workerPID:z.number().int().positive(),workerMarker:text});
export const independentCheckSchema=z.strictObject({ordinal:z.number().int().nonnegative(),kind:z.enum(["version-before","reproduction","acceptance","version-after"]),targetRef:text,command:text,result:independentCheckResultSchema.nullable()});
export function independentCheckPassed(check:z.infer<typeof independentCheckSchema>,expectedVersion:string){const result=check.result;return !!result&&result.exitCode===0&&result.exitConfirmed&&!result.truncated&&result.scopeConfirmed&&result.artifactsUnchanged&&(!(check.kind==="version-before"||check.kind==="version-after")||result.stdout.trim()===expectedVersion);}
export const independentReceiptSchema=z.strictObject({attemptId:text,sourcePreparationAttemptId:text,inputHash:hash,planHash:hash,expectedVersion:text,checks:z.array(independentCheckSchema),passed:z.boolean(),exitConfirmed:z.boolean(),workerExitConfirmed:z.boolean(),nativeScopeConfirmed:z.boolean(),reason:text});
export function compileIndependentReceipt(input:{attemptId:string;sourcePreparationAttemptId:string;inputHash:string;planHash:string;plan:PreparedRepairPlan;checks:unknown[];scopeConfirmed:boolean;workerExitConfirmed:boolean;nativeScopeConfirmed:boolean;reason?:string}){
 const checks=input.checks.map(check=>independentCheckSchema.parse(check)),steps=independentCheckSteps(input.plan);
 for(const [index,check]of checks.entries()){const step=steps[index];if(!step||check.ordinal!==index||check.kind!==step.kind||check.targetRef!==step.targetRef||check.command!==step.command)throw new Error("Independent check receipt differs from the frozen ordered plan");}
 const passed=input.scopeConfirmed&&input.nativeScopeConfirmed&&input.workerExitConfirmed&&checks.length===steps.length&&checks.every(check=>independentCheckPassed(check,input.plan.expectedVersion));
 return independentReceiptSchema.parse({attemptId:input.attemptId,sourcePreparationAttemptId:input.sourcePreparationAttemptId,inputHash:input.inputHash,planHash:input.planHash,expectedVersion:input.plan.expectedVersion,checks,passed,exitConfirmed:input.workerExitConfirmed&&checks.every(check=>check.result?.exitConfirmed===true),workerExitConfirmed:input.workerExitConfirmed,nativeScopeConfirmed:input.nativeScopeConfirmed,reason:passed?"Original reproduction, every acceptance and before/after versions passed; physical settlement and business handoff remain required":input.reason||"Independent verification incomplete, failed or changed scope"});
}
