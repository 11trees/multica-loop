import {chromium,expect,test} from "@playwright/test";
import {TestApiClient} from "./fixtures";

test("OpenSpec context is edited on the Team without changing the staged migration profile",async({baseURL},testInfo)=>{
 test.setTimeout(120000);
 test.skip(process.env.MULTICA_ENGINEERING_ENABLED!=="true" || !process.env.MULTICA_ENGINEERING_BROWSER,"Managed engineering and an explicit browser are required");
 const api=new TestApiClient();await api.loginLocally();
 const workspace=(await api.getWorkspaces()).find(item=>item.slug==="loopwork-local")!;
 api.setWorkspaceId(workspace.id);api.setWorkspaceSlug(workspace.slug);
 const teams=await api.builtinEngineeringTeams(),team=teams.find(item=>item.builtin_workflow==="develop")!;
 const browser=await chromium.launch({executablePath:process.env.MULTICA_ENGINEERING_BROWSER});
 const context=await browser.newContext({viewport:{width:1280,height:1100}});
 context.setDefaultTimeout(20000);await context.addInitScript(()=>localStorage.setItem("multica:chat:isOpen","false"));
 try{
  const page=await context.newPage();let saves=0;
  // Browser-only response fixture: the real migration cohort keeps revision 1.
  await page.route(`**/api/squads/${team.id}/engineering`,async route=>{
   if(route.request().method()==="PUT"){
    const input=route.request().postDataJSON();expect(input.expected_revision).toBe(team.profile.revision+saves);
    saves++;
    await route.fulfill({json:{enabled:true,builtin_workflow:"develop",profile:{...team.profile,revision:team.profile.revision+saves,definition:input.definition}}});
   }else await route.continue();
  });
  await page.goto(`${baseURL}/`);await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/issues`));
  await page.goto(`${baseURL}/${workspace.slug}/squads/${team.id}`);
  const section=page.locator("section").filter({has:page.getByRole("heading",{name:"Team settings",exact:true})});
  await section.getByRole("button",{name:"Edit",exact:true}).click();
  const selector=section.getByRole("combobox",{name:"Repository context",exact:true});
  await selector.click();await page.getByRole("option",{name:"OpenSpec changes",exact:true}).click();
  await expect(selector).toContainText("OpenSpec changes");
  for(const width of [1280,390]){await page.setViewportSize({width,height:1100});await section.screenshot({path:testInfo.outputPath(`team-openspec-context-${width}.png`)});}
  await section.getByRole("button",{name:"Save",exact:true}).click();
  await expect(section.getByText("Repository context · OpenSpec changes",{exact:true})).toBeVisible();
  await section.getByRole("button",{name:"Edit",exact:true}).click();
  await selector.click();await page.getByRole("option",{name:"Default",exact:true}).click();
  await section.getByRole("button",{name:"Save",exact:true}).click();
  await expect(section.getByText("Repository context · OpenSpec changes",{exact:true})).toHaveCount(0);expect(saves).toBe(2);
  expect((await api.builtinEngineeringTeams()).find(item=>item.id===team.id)).toEqual(team);
 }finally{await context.close();await browser.close();await api.cleanup();}
});
