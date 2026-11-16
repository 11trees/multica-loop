import {chromium,expect,test} from "@playwright/test";
import {TestApiClient} from "./fixtures";

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
