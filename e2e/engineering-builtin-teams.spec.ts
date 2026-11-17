import {chromium,expect,test} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {TestApiClient} from "./fixtures";

test("local users directly see the Development Team and can draft a task without per-task workflow configuration",async({baseURL},testInfo)=>{
 test.setTimeout(150000);
 test.skip(process.env.MULTICA_ENGINEERING_ENABLED!=="true" || !process.env.MULTICA_ENGINEERING_BROWSER,"Managed engineering and an explicit browser are required");
 const api=new TestApiClient();await api.loginLocally();
 const workspace=(await api.getWorkspaces()).find(item=>item.slug==="loopwork-local")!;
 api.setWorkspaceId(workspace.id);api.setWorkspaceSlug(workspace.slug);
 const teams=await api.builtinEngineeringTeams();
 expect(teams.map(team=>team.builtin_workflow)).toEqual(["develop"]);
 const develop=teams[0]!;
 const browser=await chromium.launch({executablePath:process.env.MULTICA_ENGINEERING_BROWSER});
 const context=await browser.newContext({viewport:{width:1280,height:1100}});
 context.setDefaultTimeout(20000);await context.addInitScript(()=>localStorage.setItem("multica:chat:isOpen","false"));
 try{
  const project=await api.createProject(`Built-in Team UI ${randomUUID()}`);
  const page=await context.newPage();await page.goto(`${baseURL}/`);
  await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/issues`));
  await page.goto(`${baseURL}/${workspace.slug}/squads`);
  for(const team of teams)await expect(page.getByText(team.name,{exact:true}).first()).toBeVisible();
  for(const width of [1280,390]){await page.setViewportSize({width,height:1100});await page.screenshot({path:testInfo.outputPath(`builtin-teams-${width}.png`)})}
  await page.goto(`${baseURL}/${workspace.slug}/squads/${develop.id}`);
  const section=page.locator("section").filter({has:page.getByRole("heading",{name:"Team settings",exact:true})});
  await expect(section.getByText("Applies to every role Agent in this Team.",{exact:true})).toBeVisible();
  await expect(section.getByRole("button",{name:"Set workflow",exact:true})).toHaveCount(0);
  await section.getByRole("button",{name:"Edit",exact:true}).click();
  await expect(section.getByRole("combobox",{name:"Workflow",exact:true})).toBeDisabled();
  await section.getByRole("button",{name:"Cancel",exact:true}).click();
  for(const width of [1280,390]){await page.setViewportSize({width,height:1100});await section.screenshot({path:testInfo.outputPath(`builtin-team-settings-${width}.png`)})}
  await page.setViewportSize({width:1280,height:1100});
  await page.goto(`${baseURL}/${workspace.slug}/issues`);
  await page.getByRole("button",{name:"New Issue",exact:true}).click();
  const dialog=page.getByRole("dialog"),title=`Built-in Team draft ${randomUUID()}`;
  await dialog.getByLabel("Task goal",{exact:true}).fill(title);
  await dialog.getByRole("combobox",{name:"Project",exact:true}).click();await page.getByRole("option",{name:project.title,exact:true}).click();
  await dialog.getByRole("combobox",{name:"Team",exact:true}).click();
  for(const team of teams)await expect(page.getByRole("option",{name:team.name,exact:true})).toBeVisible();
  await page.getByRole("option",{name:develop.name,exact:true}).click();
  await expect(dialog.getByRole("combobox")).toHaveCount(2);
  if(await dialog.getByRole("link",{name:"Configure the Team runtime before starting.",exact:true}).count())await expect(dialog.getByRole("button",{name:"Create and start",exact:true})).toBeDisabled();
  await page.setViewportSize({width:390,height:1100});
  await dialog.screenshot({path:testInfo.outputPath("builtin-team-task-390.png")});
  const saved=page.waitForResponse(response=>response.url().endsWith("/api/issues") && response.request().method()==="POST");
  await dialog.getByRole("button",{name:"Save draft",exact:true}).click();
  const response=await saved;expect(response.status()).toBe(201);
  const issue=await response.json();await api.trackBuiltinTeamDraft(issue.id);
  await expect(dialog).toHaveCount(0);expect(issue.assignee_id).toBe(develop.id);expect(issue.status).toBe("backlog");
 }finally{await context.close();await browser.close();await api.cleanup()}
});
