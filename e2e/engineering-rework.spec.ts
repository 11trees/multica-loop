import { test, expect, chromium } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TestApiClient } from "./fixtures";

test("failed independent verification automatically returns to fresh development and rechecks the retained plan", async ({ baseURL }, testInfo) => {
  test.setTimeout(180000);
  test.skip(process.env.MULTICA_ENGINEERING_ENABLED !== "true" || !process.env.MULTICA_ENGINEERING_BROWSER || !process.env.MULTICA_ENGINEERING_CLI, "Requires the managed service, built CLI, and explicit browser binary");
  const api = new TestApiClient(); await api.loginLocally();
  const workspace = (await api.getWorkspaces()).find(value => value.slug === "loopwork-local")!;
  api.setWorkspaceId(workspace.id); api.setWorkspaceSlug(workspace.slug);
  const directory = await mkdtemp(join(tmpdir(), "engineering-rework-")), repository = join(directory, "repository");
  execFileSync("git", ["init", "-q", repository]);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "user.name", "Rework fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "index.html"), "<!doctype html><h1>Initial</h1>"); git("add", "."); git("commit", "-qm", "Initialize fixture");
  const browser = await chromium.launch({ executablePath: process.env.MULTICA_ENGINEERING_BROWSER });
  const context = await browser.newContext({ viewport: { width:1280,height:960 } });
  await context.addInitScript(() => { localStorage.setItem("multica:chat:isOpen", "false"); });
  try {
    const developer = await api.seedEngineeringRun(), verifier = await api.seedEngineeringRun(developer.issueId);
    await api.finishEngineeringRun(verifier.taskId);
    const project = await api.createProject(`Rework fixture ${developer.issueId}`);
    await api.attachEngineeringProject(developer.taskId,project.id,repository); await api.attachEngineeringProject(verifier.taskId,project.id,repository);
    await api.engineeringVerification(developer.issueId,"configure",{ expected_revision:0,agent_id:verifier.agentId,developer_agent_id:developer.agentId,repository_path:repository,implementation_guidance:"Implement the exact Ready heading without changing its oracle",auto_continue:true,max_reworks:1,
      sources:[{key:"ac1",kind:"acceptance",description:"The page displays Ready",oracle:"A browser sees the exact Ready heading",sourceRef:"FIXTURE:heading:r1"}] });
    let owner = developer;
    const cli = (name: string, payload?: unknown) => JSON.parse(execFileSync(resolve(process.env.MULTICA_ENGINEERING_CLI!),["engineering",name,...(payload ? ["--payload",JSON.stringify(payload)] : [])],{
      cwd:directory,encoding:"utf8",timeout:20000,stdio:["ignore","pipe","pipe"],env:{...process.env,MULTICA_SERVER_URL:owner.apiBase,MULTICA_TOKEN:owner.taskToken,MULTICA_WORKSPACE_ID:workspace.id,MULTICA_TASK_ID:owner.taskId,MULTICA_AGENT_ID:owner.agentId},
    }));
    let state: ReturnType<typeof cli>;
    const command = (command: unknown) => { state = cli("command",{expected_sequence:state.draft.sequence,command}); };
    const begin = async (run: typeof developer) => { owner=run;await api.bindEngineeringRepository(run.taskId,repository);state=cli("start"); };
    const next = async (agentId: string) => {
      await expect.poll(() => api.queuedEngineeringRun(developer.issueId,agentId),{timeout:40000}).not.toBeNull();
      return api.claimEngineeringRun((await api.queuedEngineeringRun(developer.issueId,agentId))!);
    };
    const implement = async (heading: string) => {
      expect(state.draft.development?.claims ?? []).toEqual([]); expect(state.draft.development?.checks ?? []).toEqual([]);
      command({type:"phase.complete"}); await writeFile(join(repository,"index.html"),`<!doctype html><h1>${heading}</h1>`);
      command({type:"acceptance.assess",key:"ac1",evidence:"index.html:1"});
      for (const recovery of state.contract.sources.filter((source:{kind:string}) => source.kind === "recovery")) command({type:"artifact.put",ref:"development.recovery-resolutions",key:recovery.key,content:"summary: Correct the independently observed heading mismatch\nevidence: index.html:1"});
      command({type:"phase.complete"}); command({type:"artifact.put",ref:"development.code-review",content:"summary: Fresh implementation review\nevidence: index.html:1"}); command({type:"phase.complete"});
      const script="if(!require('node:fs').readFileSync('index.html','utf8').includes('<h1>'))process.exit(1)";
      const checked=spawnSync(process.execPath,["-e",script],{cwd:repository,encoding:"utf8"}); expect(checked.status).toBe(0);
      const receipt=await api.captureEngineeringReceipt(owner.taskId,{id:"html-check",sequence:1,result:{command:`node -e ${JSON.stringify(script)}`,cwd:repository,status:"completed",exit_code:checked.status}});
      command({type:"check.record",key:"html",receipt_id:receipt.captured,summary:"Actual HTML structure check"}); command({type:"phase.complete"});
      git("add","index.html");git("commit","-qm",`Implement ${heading}`);command({type:"phase.complete",confirmation:"Scoped commit checked"});command({type:"phase.complete",confirmation:"Fresh review and checks match commit"});
      await api.finishEngineeringRun(owner.taskId);
    };
    const conclude = (verdict:"passed"|"failed") => {
      command({type:"artifact.put",ref:"verification.results",key:"s1",content:`status: ${verdict}\nevidence: Chromium observed the committed fixture heading\nactualBehavior: Heading is ${verdict === "failed" ? "Almost ready" : "Ready"}${verdict === "failed" ? "\nfailureKind: implementation" : ""}`});command({type:"phase.complete"});
      command({type:"artifact.put",ref:"verification.evidence-review",content:"summary: Exact heading compared with frozen Ready oracle"});command({type:"phase.complete"});command({type:"phase.complete"});
    };
    await begin(developer);await implement("Almost ready");
    await begin(await next(verifier.agentId)); command({type:"phase.complete"});
    command({type:"artifact.put",ref:"verification.scenarios",key:"s1",content:"channel: frontend\ntitle: Exact heading\nsetup: Open committed fixture\nsteps: Observe h1\nexpected: Ready\ncoverageRefs: [ac1]"});command({type:"phase.complete"});
    const observation=await context.newPage();await observation.goto(pathToFileURL(join(repository,"index.html")).href);await expect(observation.getByRole("heading",{name:"Almost ready",exact:true})).toBeVisible();
    const failedDraft=state.draft.id;conclude("failed");expect(state.conclusion.verdict).toBe("failed");
    expect(state.rework).toMatchObject({round:1,limit:1,history:[{draft_id:failedDraft}]});
    await expect(api.updateIssue(developer.issueId,{status:"done",suppress_run:true})).rejects.toThrow(/409.*not handed off/);
    const page=await context.newPage();await page.goto(`${baseURL}/`,{waitUntil:"domcontentloaded"});await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/issues$`),{timeout:30000});await page.goto(`${baseURL}/${workspace.slug}/issues/${developer.issueId}`);
    await page.setViewportSize({width:1280,height:1600});
    const panel=page.getByRole("region",{name:"Engineering delivery"});await expect(panel.getByText("Rework 1 of 1")).toBeVisible();
    await panel.getByText("Failed verification history",{exact:true}).click();await panel.locator("summary").filter({hasText:"Revision 1"}).click();
    await expect(panel.getByText(/actualBehavior: Heading is Almost ready/)).toBeVisible();
    const pendingScreenshot=testInfo.outputPath("rework-pending.png");await panel.screenshot({path:pendingScreenshot});await testInfo.attach("Failed verification retained during rework",{path:pendingScreenshot,contentType:"image/png"});
    await api.finishEngineeringRun(owner.taskId);await begin(await next(developer.agentId));expect(state.contract.binding.revision).toBe(2);
    expect(state.contract.sources.some((source:{kind:string;sourceRef:string})=>source.kind === "recovery" && source.sourceRef.includes(failedDraft))).toBe(true);
    await implement("Ready");await begin(await next(verifier.agentId));expect(state.draft.phase).toBe("execute");
    expect(state.draft.artifacts.filter((item:{ref:string})=>item.ref === "verification.results" || item.ref === "verification.evidence-review")).toEqual([]);
    await observation.reload();await expect(observation.getByRole("heading",{name:"Ready",exact:true})).toBeVisible();conclude("passed");await api.finishEngineeringRun(owner.taskId);
    await panel.getByRole("button",{name:"Refresh engineering delivery"}).click();await expect(panel.getByText("Verification passed",{exact:true})).toBeVisible();
    const resultScreenshot=testInfo.outputPath("rework-verified.png");await panel.screenshot({path:resultScreenshot});await testInfo.attach("Fresh recheck passed with failure history retained",{path:resultScreenshot,contentType:"image/png"});
    expect((await api.updateIssue(developer.issueId,{status:"done",suppress_run:true})).status).toBe("done");
  } finally { await context.close();await browser.close();await api.cleanup();await rm(directory,{recursive:true,force:true}); }
});
