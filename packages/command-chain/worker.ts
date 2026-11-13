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
const database = process.argv[2];
if (!database) throw new Error("Engineering database path is required");
mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
const app = new EngineeringApplication(database, DEFAULT_VERIFICATION_SOURCE, DEFAULT_DEVELOPMENT_SOURCE, DEFAULT_ANALYSIS_SOURCE,{context:DEFAULT_CONTEXT_SOURCE,planning:DEFAULT_PLANNING_SOURCE,review:DEFAULT_REVIEW_SOURCE});
try {
  const request = applicationRequestSchema.parse(JSON.parse(readFileSync(0, "utf8")));
  const result = await app.invoke(request);
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  const message = error instanceof Error ? error.message : "Engineering request failed";
  process.stdout.write(JSON.stringify({ error: message, conflict: error instanceof DraftConflictError }));
} finally { app.close(); }
