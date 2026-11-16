import { createHash } from "node:crypto";
import { z } from "zod";
import type { RepairVerificationInput } from "./repair-verification-input";
const text=z.string().trim().min(1),hash=text.regex(/^[a-f0-9]{64}$/);
const check=z.strictObject({targetRef:text,command:text.max(16000)});
export const authoredRepairPlanSchema=z.strictObject({reproduction:check,acceptanceChecks:z.array(check).min(1).max(10000)});
export function verificationArtifactsHash(files:{path:string;kind:string;hash:string;size:number;mode:number}[],mode:number){const value=createHash("sha256").update(`${mode}\n`);for(const file of files)value.update(`${file.path}\0${file.kind}\0${file.hash}:${file.size}:${file.mode}\n`);return value.digest("hex");}
export const verificationArtifactsSchema=z.strictObject({directory:text,mode:z.number().int().nonnegative(),hash,files:z.array(z.strictObject({kind:z.enum(["file","directory"]),path:text.refine(path=>!path.startsWith("/")&&!path.includes("\\")&&path.split("/").every(part=>!!part&&part!=="."&&part!=="..")),hash,size:z.number().int().nonnegative(),mode:z.number().int().nonnegative()})).min(1).max(10000)}).superRefine((value,ctx)=>{if(verificationArtifactsHash(value.files,value.mode)!==value.hash)ctx.addIssue({code:"custom",message:"Verification artifact manifest hash changed"});if(new Set(value.files.map(file=>file.path)).size!==value.files.length)ctx.addIssue({code:"custom",message:"Verification artifact paths must be unique"});});
export const preparedRepairPlanSchema=z.strictObject({inputHash:hash,sourceRepairAttemptId:text,expectedVersion:text,reproduction:check,acceptanceChecks:z.array(check).min(1).max(10000),artifacts:verificationArtifactsSchema});
export function authorizeRepairPlan(input:RepairVerificationInput,inputHash:string,proposed:unknown,artifacts:unknown){
 const authored=authoredRepairPlanSchema.parse(proposed),expected=input.targets.map(target=>target.targetRef).sort(),actual=authored.acceptanceChecks.map(item=>item.targetRef).sort();
 if(authored.reproduction.targetRef!=="original-failures"||JSON.stringify(expected)!==JSON.stringify(actual))throw new Error("Independent checks must reproduce original failures and cover every exact frozen target");
 return preparedRepairPlanSchema.parse({inputHash,sourceRepairAttemptId:input.sourceRepairAttemptId,expectedVersion:input.expectedVersion,...authored,artifacts});
}
