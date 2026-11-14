import { z } from "zod";

export const directSubmissionSchema = z.strictObject({
  summary: z.string().trim().min(1).max(4000),
  result: z.string().trim().max(100000).optional(),
});

export function directResult(input: unknown) {
  const value = directSubmissionSchema.parse(input);
  return { summary: value.summary, content: value.result?.trim() || value.summary };
}

export const directInstructions = "Direct executes only the frozen original input. First run multica engineering direct-run. Complete the actual work, then save a summary (at most 4000 characters) and optional full Markdown result (at most 100000 characters) in the task-private TMPDIR. Submit with multica engineering direct-submit --summary-file <file> [--result-file <file>]. Ordinary final text or process exit cannot submit a result. Do not create analysis, planning, independent verification or report-review stages. Do not ask questions or invent completion/evidence; retain actual errors when unable to finish. Direct is explicit result submission, not independent delivered-code verification.";
