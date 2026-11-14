import { createHash } from "node:crypto";
import { AdminStore, invokeAdmin } from "./admin-store";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EngineeringApplication, applicationRequestSchema } from "./application";
import { DraftConflictError } from "./runtime";

declare const DEFAULT_VERIFICATION_SOURCE: string;
declare const DEFAULT_DEVELOPMENT_SOURCE: string;
declare const DEFAULT_ANALYSIS_SOURCE: string;
declare const DEFAULT_CONTEXT_SOURCE:string;
declare const DEFAULT_PLANNING_SOURCE:string;
declare const DEFAULT_REVIEW_SOURCE:string;
declare const DEFAULT_REPRODUCTION_SOURCE:string;
declare const DEFAULT_FEEDBACK_TRIAGE_SOURCE:string;
declare const DEFAULT_FEEDBACK_VERIFY_SOURCE:string;
declare const DEFAULT_IDEA_CONTEXT_SOURCE:string;
declare const DEFAULT_BUSINESS_DESIGN_SOURCE:string;
declare const DEFAULT_REQUIREMENT_SPEC_SOURCE:string;
declare const DEFAULT_SPEC_REVIEW_SOURCE:string;
const database = process.argv[2];
if (!database) throw new Error("Engineering database path is required");
mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
const kernelVersion = `sha256:${createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex")}`;
let app: EngineeringApplication | undefined;
let admin: AdminStore | undefined;
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  let result: unknown;
  if (process.argv[3] === "--admin") {
    admin = new AdminStore(database);
    result = invokeAdmin(admin,input);
  } else {
    app = new EngineeringApplication(database, DEFAULT_VERIFICATION_SOURCE, DEFAULT_DEVELOPMENT_SOURCE, DEFAULT_ANALYSIS_SOURCE,{context:DEFAULT_CONTEXT_SOURCE,planning:DEFAULT_PLANNING_SOURCE,review:DEFAULT_REVIEW_SOURCE,reproduction:DEFAULT_REPRODUCTION_SOURCE,feedback:{triage:DEFAULT_FEEDBACK_TRIAGE_SOURCE,verify:DEFAULT_FEEDBACK_VERIFY_SOURCE}},{intent:DEFAULT_IDEA_CONTEXT_SOURCE,business_design:DEFAULT_BUSINESS_DESIGN_SOURCE,specification:DEFAULT_REQUIREMENT_SPEC_SOURCE,review:DEFAULT_SPEC_REVIEW_SOURCE},kernelVersion);
    result = await app.invoke(applicationRequestSchema.parse(input));
  }
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  const message = error instanceof Error ? error.message : "Engineering request failed";
  process.stdout.write(JSON.stringify({ error: message, conflict: error instanceof DraftConflictError }));
} finally { app?.close(); admin?.close(); }
