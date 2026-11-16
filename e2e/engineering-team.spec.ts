import {chromium,expect,test} from "@playwright/test";
import {TestApiClient} from "./fixtures";
import {mkdtemp,realpath,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";

test("Team owns its predefined workflow and member roles",async({baseURL},testInfo)=>{
 test.setTimeout(150000);test.skip(process.env.MULTICA_ENGINEERING_ENABLED!=="true" || !process.env.MULTICA_ENGINEERING_BROWSER,"Managed engineering and an explicit browser are required");
 const api=new TestApiClient();await api.loginLocally();const workspace=(await api.getWorkspaces()).find(item=>item.slug==="loopwork-local")!;api.setWorkspaceId(workspace.id);api.setWorkspaceSlug(workspace.slug);
 const browser=await chromium.launch({executablePath:process.env.MULTICA_ENGINEERING_BROWSER});const context=await browser.newContext({viewport:{width:1280,height:1200}});context.setDefaultTimeout(20000);await context.addInitScript(()=>localStorage.setItem("multica:chat:isOpen","false"));
 try{
  const fixture=await api.seedEngineeringRun(),team=await api.createWorkflowTeamFixture(fixture.agentId),page=await context.newPage();
  await page.goto(`${baseURL}/`);await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/issues`));await page.goto(`${baseURL}/${workspace.slug}/squads/${team.id}`);
  const section=page.locator("section").filter({has:page.getByRole("heading",{name:"Working method",exact:true})});await section.getByRole("button",{name:"Set workflow",exact:true}).click();
  await expect(section.getByRole("combobox",{name:"Workflow",exact:true})).toBeVisible();await expect(section.getByRole("combobox",{name:"Executing agent",exact:true})).toBeVisible();
  await section.getByRole("button",{name:"Save",exact:true}).click();
  await expect.poll(async()=>((await api.readWorkflowTeamFixture(team.id)).profile?.revision)).toBe(1);
  const saved=await api.readWorkflowTeamFixture(team.id);expect(saved.profile.definition).toEqual({workflow:"direct",roles:{executor:fixture.agentId},decision_mode:"balanced",max_reworks:2});expect(saved.profile.definition).not.toHaveProperty("repository_path");
  await page.reload();await expect(section.getByText("Direct execution",{exact:true})).toBeVisible();
  for(const width of [1280,390]){await page.setViewportSize({width,height:1200});expect(await section.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);await section.screenshot({path:testInfo.outputPath(`team-workflow-${width}.png`)})}
 }finally{await context.close();await browser.close();await api.cleanup()}
});

test("tasks choose a Team, save drafts and start the frozen Team without individual Agent configuration",async({baseURL},testInfo)=>{
 test.setTimeout(150000);test.skip(process.env.MULTICA_ENGINEERING_ENABLED!=="true" || !process.env.MULTICA_ENGINEERING_BROWSER,"Managed engineering and an explicit browser are required");
 const api=new TestApiClient();await api.loginLocally();const workspace=(await api.getWorkspaces()).find(item=>item.slug==="loopwork-local")!;api.setWorkspaceId(workspace.id);api.setWorkspaceSlug(workspace.slug);
 const directory=await realpath(await mkdtemp(join(tmpdir(),"team-task-ui-"))),browser=await chromium.launch({executablePath:process.env.MULTICA_ENGINEERING_BROWSER}),context=await browser.newContext({viewport:{width:1280,height:1100}});context.setDefaultTimeout(20000);await context.addInitScript(()=>localStorage.setItem("multica:chat:isOpen","false"));
 try{
  const fixture=await api.seedEngineeringRun(),team=await api.createWorkflowTeamFixture(fixture.agentId),project=await api.createProject(`Team project ${randomUUID()}`);
  await api.configureWorkflowTeamFixture(team.id,fixture.agentId);await api.attachEngineeringProject(fixture.taskId,project.id,directory);
  const page=await context.newPage();await page.goto(`${baseURL}/`);await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/issues`));
  for(const draft of [true,false]){
   await page.getByRole("button",{name:"New Issue",exact:true}).click();const dialog=page.getByRole("dialog");await expect(dialog.getByRole("heading",{name:"New task",exact:true})).toBeVisible();
   const goal=`Team workflow UI ${draft?"draft":"start"} ${randomUUID()}`;await dialog.getByLabel("Task goal",{exact:true}).fill(goal);await dialog.locator("[contenteditable=true]").fill("Task materials fixture");
   await dialog.getByRole("combobox",{name:"Project",exact:true}).click();await page.getByRole("option",{name:project.title,exact:true}).click();
   await dialog.getByRole("combobox",{name:"Team",exact:true}).click();await page.getByRole("option",{name:team.name,exact:true}).click();
   await expect(dialog.getByRole("combobox")).toHaveCount(2);await expect(dialog.getByText("Version 1",{exact:false})).toBeVisible();
   if(!draft)for(const width of [1280,390]){await page.setViewportSize({width,height:1100});expect(await dialog.evaluate(element=>{const outer=element.getBoundingClientRect();return [...element.querySelectorAll("input,[role=combobox],button[type=submit]")].every(control=>control.getBoundingClientRect().right<=outer.right+1)})).toBe(true);await dialog.screenshot({path:testInfo.outputPath(`team-task-create-${width}.png`)})}
   const saved=page.waitForResponse(response=>response.url().endsWith("/api/issues") && response.request().method()==="POST");
   await dialog.getByRole("button",{name:draft?"Save draft":"Create and start",exact:true}).click();const response=await saved;expect(response.status()).toBe(201);const issue=await response.json();await api.trackWorkflowTeamIssueFixture(team.id,project.id,issue.id);
   await expect(dialog).toHaveCount(0);await expect(page).toHaveURL(new RegExp(`/issues/${issue.id}`));
   const state=await api.engineeringOverview(issue.id);
   if(draft){expect(issue.status).toBe("backlog");expect(state.configured).toBe(false);expect(await api.queuedEngineeringRun(issue.id,fixture.agentId)).toBeNull();const started=page.waitForResponse(response=>response.url().endsWith(`/api/issues/${issue.id}/engineering/team-start`) && response.request().method()==="POST");await page.getByRole("button",{name:"Start Team workflow",exact:true}).click();const startResponse=await started;expect(startResponse.status(),await startResponse.text()).toBe(200);await expect.poll(async()=>(await api.engineeringOverview(issue.id)).configured).toBe(true);expect(await api.queuedEngineeringRun(issue.id,fixture.agentId)).toBeTruthy()}
   else{
    expect(state.configured).toBe(true);expect(state.team).toMatchObject({id:team.id,workflow:"direct",revision:1,frozen:true,aligned:true});expect(state.direct.input).toBe(goal+"\n\nTask materials fixture");
    expect(await api.queuedEngineeringRun(issue.id,fixture.agentId)).toBeTruthy();await expect(page.getByText("The Team, project and goal are frozen for this task.",{exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:/Configure delivery|Configure requirement/})).toHaveCount(0);await expect(page.getByRole("heading",{name:goal,exact:true})).toBeVisible();await expect(page.getByText("Task materials fixture",{exact:true})).toBeVisible();
    await page.locator("section").filter({has:page.getByText("The Team, project and goal are frozen for this task.",{exact:true})}).screenshot({path:testInfo.outputPath("team-task-progress-390.png")});
   }
   await page.setViewportSize({width:1280,height:1100});await page.goto(`${baseURL}/${workspace.slug}/issues`);
  }
 }finally{await context.close();await browser.close();await api.cleanup();await rm(directory,{recursive:true,force:true})}
});
