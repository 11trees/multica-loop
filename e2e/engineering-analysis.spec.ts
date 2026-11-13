import { test,expect,chromium } from "@playwright/test";
import { execFileSync,spawnSync } from "node:child_process";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TestApiClient } from "./fixtures";

test("delivery analysis records a real human choice and hands a frozen spec through development to independent verification",async({baseURL},testInfo)=>{
  test.setTimeout(240000);
  test.skip(process.env.MULTICA_ENGINEERING_ENABLED !== "true" || !process.env.MULTICA_ENGINEERING_BROWSER || !process.env.MULTICA_ENGINEERING_CLI,"Requires the managed local service, CLI, and explicit browser binary");
  const api=new TestApiClient();await api.loginLocally();const workspace=(await api.getWorkspaces()).find(value=>value.slug === "loopwork-local")!;
  api.setWorkspaceId(workspace.id);api.setWorkspaceSlug(workspace.slug);
  const directory=await mkdtemp(join(tmpdir(),"engineering-analysis-")),repository=join(directory,"repository");execFileSync("git",["init","-q",repository]);
  const git=(...args:string[])=>execFileSync("git",["-C",repository,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  git("config","user.name","Analysis fixture");git("config","user.email","fixture@example.invalid");await writeFile(join(repository,"index.html"),"<!doctype html><p>Existing</p><h1>Initial</h1>");git("add",".");git("commit","-qm","Initialize analysis fixture");
  const browser=await chromium.launch({executablePath:process.env.MULTICA_ENGINEERING_BROWSER}),context=await browser.newContext({viewport:{width:1280,height:1600}});
  await context.addInitScript(()=>{localStorage.setItem("multica:chat:isOpen","false");});
  try{
    const analyst=await api.seedEngineeringRun(),developer=await api.seedEngineeringRun(analyst.issueId),verifier=await api.seedEngineeringRun(analyst.issueId);
    const project=await api.createProject(`Analysis fixture ${analyst.issueId}`);
    for(const run of [analyst,developer,verifier]){await api.finishEngineeringRun(run.taskId);await api.attachEngineeringProject(run.taskId,project.id,repository);}
    const page=await context.newPage();await page.goto(`${baseURL}/`);await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/issues$`),{timeout:30000});await page.goto(`${baseURL}/${workspace.slug}/issues/${analyst.issueId}`);
    const panel=page.getByRole("region",{name:"Engineering delivery"});await panel.getByRole("button",{name:"Configure delivery"}).click({timeout:30000});const dialog=page.getByRole("dialog");
    await dialog.getByLabel("Repository path").fill(repository);await dialog.getByRole("switch",{name:"Include delivery analysis"}).click();
    for(const [label,run] of [["Analysis agent",analyst],["Development agent",developer],["Independent verification agent",verifier]] as const){await dialog.getByRole("combobox",{name:label}).click();await page.getByRole("option",{name:`Engineering fixture ${run.agentId}`,exact:true}).click();}
    await dialog.getByLabel("Who uses it").fill("Reader");await dialog.getByLabel("Trigger",{exact:true}).fill("Open the fixture page");await dialog.getByLabel("Observable outcome").fill("Exact Ready heading with existing content preserved");
    await dialog.getByLabel("Scope",{exact:true}).fill("The page displays Ready");await dialog.getByLabel("Expected result",{exact:true}).fill("A browser sees the exact Ready heading");
    await dialog.getByRole("button",{name:"Freeze scope"}).click();await expect(dialog).not.toBeVisible();
    const queued=page.waitForResponse(response=>response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/engineering/run"));await panel.getByRole("button",{name:"Start run"}).click();const first=await queued;expect(first.status()).toBe(202);const firstTask=await first.json();expect(firstTask.agent_id).toBe(analyst.agentId);
    let owner=await api.claimEngineeringRun(firstTask.id);
    const cli=(name:string,payload?:unknown)=>JSON.parse(execFileSync(resolve(process.env.MULTICA_ENGINEERING_CLI!),["engineering",name,...(payload ? ["--payload",JSON.stringify(payload)] : [])],{cwd:directory,encoding:"utf8",timeout:20000,stdio:["ignore","pipe","pipe"],env:{...process.env,MULTICA_SERVER_URL:owner.apiBase,MULTICA_TOKEN:owner.taskToken,MULTICA_WORKSPACE_ID:workspace.id,MULTICA_TASK_ID:owner.taskId,MULTICA_AGENT_ID:owner.agentId}}));
    let state:ReturnType<typeof cli>;
    const begin=async(run:typeof owner)=>{owner=run;await api.bindEngineeringRepository(run.taskId,repository);state=cli("start");};
    const command=(command:unknown)=>{state=cli("command",{expected_sequence:state.draft.sequence,command});};
    const next=async(agentId:string)=>{await expect.poll(()=>api.queuedEngineeringRun(analyst.issueId,agentId),{timeout:40000}).not.toBeNull();return api.claimEngineeringRun((await api.queuedEngineeringRun(analyst.issueId,agentId))!);};
    await begin(owner);expect(state.chain).toBe("analysis");expect(state.contract.unit.actor).toBe("Reader");const analysisDraft=state.draft.id;
    command({type:"phase.complete"});command({type:"artifact.put",ref:"delivery-analysis.impacts",key:"heading",content:"area: Heading placement\nfinding: Placement changes the visible result\ndisposition: needs_decision\nevidence: index.html:1\ndecision: placement"});command({type:"phase.complete"});
    command({type:"decision.propose",decision:{key:"placement",type:"business",title:"Heading placement",question:"Where should Ready appear?",impact:"Changes the reading order",options:[{id:"top",label:"Before existing content",consequence:"Heading comes first"},{id:"bottom",label:"After existing content",consequence:"Existing paragraph stays first"}],recommendation:{option:"top",reason:"Heading is visible first",authority:"user"},dependencies:[]}});command({type:"phase.complete"});command({type:"decision.ask",key:"placement"});command({type:"phase.complete"});expect(state.draft.status).toBe("waiting_for_answers");await api.finishEngineeringRun(owner.taskId);
    await panel.getByRole("button",{name:"Refresh engineering delivery"}).click();await expect(panel.getByText("Where should Ready appear?",{exact:true})).toBeVisible();await expect(panel.getByRole("button",{name:"Submit answer"})).toBeDisabled();
    const pendingScreenshot=testInfo.outputPath("analysis-decision.png");await panel.screenshot({path:pendingScreenshot});await testInfo.attach("Human analysis option choice",{path:pendingScreenshot,contentType:"image/png"});
    await panel.getByRole("button",{name:"Use recommendation"}).click();expect((await api.engineeringVerification(analyst.issueId,"inspect")).draft.runtimeInputs[0].answer).toBeNull();
    await panel.getByRole("combobox",{name:"Your choice"}).click();await page.getByRole("option",{name:/After existing content/}).click();await panel.getByLabel("Note (optional)").fill("");await panel.getByRole("button",{name:"Submit answer"}).click();
    await expect.poll(async()=> (await api.engineeringVerification(analyst.issueId,"inspect")).draft.runtimeInputs[0].answer?.selectedOption).toBe("bottom");
    const answer=(await api.engineeringVerification(analyst.issueId,"inspect")).draft.runtimeInputs[0].answer;expect(answer.userId).toBe(analyst.userId);
    await begin(await next(analyst.agentId));expect(state.draft.id).toBe(analysisDraft);expect(state.draft.phase).toBe("decision_resolution");
    command({type:"decision.resolve",key:"placement",option:"bottom",authority:"user",decision:"Heading after existing content",rationale:"The human selected bottom",evidence:state.draft.runtimeInputs[0].id});
    command({type:"artifact.put",ref:"delivery-analysis.impacts",key:"heading",content:"area: Heading placement\nfinding: Keep paragraph first and show exact Ready after it\ndisposition: change\nevidence: Authenticated human option bottom\ndecision: placement"});command({type:"phase.complete"});
    command({type:"artifact.put",ref:"delivery-analysis.answer-review",content:"The selected bottom option preserves existing content and changes only the heading."});command({type:"phase.complete"});
    command({type:"artifact.put",ref:"delivery-analysis.summary",content:"Show Ready after existing content."});command({type:"artifact.put",ref:"delivery-analysis.contract",content:"Render an h1 with exact Ready after the existing paragraph."});
    command({type:"artifact.put",ref:"delivery-analysis.guardrails",key:"existing",content:"content: Preserve the Existing paragraph\nrationale: Keep the current reader context"});command({type:"artifact.put",ref:"delivery-analysis.verification-focus",key:"order",content:"expected: Existing paragraph precedes Ready\noracle: Browser DOM order is paragraph then h1"});command({type:"phase.complete"});command({type:"phase.complete",confirmation:"Scope, human decision, and delivery contract align"});
    expect(state.conclusion.decisions[0].resolution).toMatchObject({option:"bottom",userId:analyst.userId});await api.finishEngineeringRun(owner.taskId);
    await begin(await next(developer.agentId));expect(state.chain).toBe("development");expect(state.contract.implementationGuidance).toBe("Render an h1 with exact Ready after the existing paragraph.");expect(state.contract.sources.map((source:{kind:string})=>source.kind)).toEqual(["acceptance","guardrail","focus"]);
    command({type:"phase.complete"});await writeFile(join(repository,"index.html"),"<!doctype html><p>Existing</p><h1>Ready</h1>");command({type:"acceptance.assess",key:"scope-1",evidence:"index.html:1"});command({type:"phase.complete"});command({type:"artifact.put",ref:"development.code-review",content:"summary: Only heading changed; paragraph and chosen order preserved\nevidence: index.html:1"});command({type:"phase.complete"});
    const script="const s=require('node:fs').readFileSync('index.html','utf8');if(!s.includes('<h1>Ready</h1>')||s.indexOf('<p>Existing</p>')>s.indexOf('<h1>Ready</h1>'))process.exit(1)";const check=spawnSync(process.execPath,["-e",script],{cwd:repository,encoding:"utf8"});expect(check.status).toBe(0);
    const receipt=await api.captureEngineeringReceipt(owner.taskId,{id:"heading",sequence:1,result:{command:`node -e ${JSON.stringify(script)}`,cwd:repository,status:"completed",exit_code:check.status}});command({type:"check.record",key:"heading",receipt_id:receipt.captured,summary:"Actual heading and order check"});command({type:"phase.complete"});git("add","index.html");git("commit","-qm","Implement frozen analyzed heading");command({type:"phase.complete",confirmation:"Scoped commit checked"});command({type:"phase.complete",confirmation:"Implementation, review, and captured check align"});await api.finishEngineeringRun(owner.taskId);
    await begin(await next(verifier.agentId));expect(state.chain).toBe("verification");command({type:"phase.complete"});
    const coverage=state.contract.sources.map((source:{key:string})=>source.key).join(", ");command({type:"artifact.put",ref:"verification.scenarios",key:"s1",content:`channel: frontend\ntitle: Heading and chosen order\nsetup: Open committed fixture\nsteps: Read paragraph and heading\nexpected: Existing then exact Ready\ncoverageRefs: [${coverage}]`});command({type:"phase.complete"});
    const observation=await context.newPage();await observation.goto(pathToFileURL(join(repository,"index.html")).href);await expect(observation.getByRole("heading",{name:"Ready",exact:true})).toBeVisible();expect(await observation.locator("body > *").allTextContents()).toEqual(["Existing","Ready"]);await observation.close();
    command({type:"artifact.put",ref:"verification.results",key:"s1",content:"status: passed\nevidence: Chromium saw Existing followed by the exact Ready heading"});command({type:"phase.complete"});command({type:"artifact.put",ref:"verification.evidence-review",content:"summary: Browser evidence covers original acceptance, preserved paragraph, and chosen order"});command({type:"phase.complete"});command({type:"phase.complete"});await api.finishEngineeringRun(owner.taskId);
    await panel.getByRole("button",{name:"Refresh engineering delivery"}).click();await expect(panel.getByText("Verification passed",{exact:true})).toBeVisible();await panel.getByText("Delivery spec",{exact:true}).click();await panel.getByText("Decisions",{exact:true}).click();await expect(panel.getByText("Heading after existing content",{exact:true})).toBeVisible();
    const passedScreenshot=testInfo.outputPath("analysis-delivery-passed.png");await panel.screenshot({path:passedScreenshot});await testInfo.attach("Analyzed contract and human choice retained after verification",{path:passedScreenshot,contentType:"image/png"});
    expect((await api.updateIssue(analyst.issueId,{status:"done",suppress_run:true})).status).toBe("done");
  }finally{await context.close();await browser.close();await api.cleanup();await rm(directory,{recursive:true,force:true});}
});
