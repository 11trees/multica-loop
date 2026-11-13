import {test,expect,chromium} from "@playwright/test";
import {TestApiClient} from "./fixtures";

test("feedback work roles and authorization remain within desktop and narrow dialogs",async({baseURL},testInfo)=>{
 test.skip(!process.env.MULTICA_ENGINEERING_BROWSER,"Requires an explicit browser binary");
 const api=new TestApiClient();await api.loginLocally();const workspace=(await api.getWorkspaces()).find(item=>item.slug === "loopwork-local")!;api.setWorkspaceId(workspace.id);api.setWorkspaceSlug(workspace.slug);
 const issue=await api.createIssue("Feedback authorization layout fixture"),planner=await api.seedEngineeringRun(issue.id),reproducer=await api.seedEngineeringRun(issue.id),verifier=await api.seedEngineeringRun(issue.id);for(const run of [planner,reproducer,verifier])await api.finishEngineeringRun(run.taskId);
 const overview={enabled:true,configured:true,chain:"feedback-triage",agent_id:planner.agentId,revision:1,sequence:20,status:"completed",has_active_run:false,feedback_allowed:true,questions:[],requirement:{kind:"requirement",input:"Frozen comments",context:null,plan:null,delivery_policy:{analystId:"analyst",developerId:"developer",verifierId:"verifier",maxReworks:1,mode:"in_place",userId:"human"},feedback:{enabled:true,active:true,unresolved_count:1,expected_batch_number:1,batches:[{id:"batch",number:1,version:1,status:"executing",agent_id:planner.agentId,verifier_id:verifier.agentId,forward_work:null,summary:"Reproduce the reader mismatch",comments:[],groups:[{id:"group",key:"bug",workType:"bug",status:"waiting_for_repro",title:"Reader mismatch",reason:"Frozen reported behavior",response:"",commentIds:["comment"],affectedDeliveryUnits:[],acceptance:["Original behavior is restored"]}]}]}}};
 const browser=await chromium.launch({executablePath:process.env.MULTICA_ENGINEERING_BROWSER}),context=await browser.newContext({viewport:{width:1280,height:1200}});context.setDefaultTimeout(15000);
 try{
  const page=await context.newPage();await page.route(`**/api/issues/${issue.id}/engineering`,route=>route.fulfill({json:overview}));let authorized=false;await page.route(`**/api/issues/${issue.id}/engineering/feedback/work`,async route=>{expect(route.request().postDataJSON()).toEqual({batch_id:"batch",expected_version:1,planner_agent_id:planner.agentId,reproduction_agent_id:reproducer.agentId});authorized=true;await route.fulfill({json:{authorized:true}});});
  await page.goto(`${baseURL}/`);await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/issues$`));const identity=await api.getOwnedEngineeringIssue(issue.id);await page.goto(`${baseURL}/${workspace.slug}/issues/${identity.identifier}`);
  const panel=page.getByRole("region",{name:"Engineering delivery"});
  for(const width of [1280,390]){
   await page.setViewportSize({width,height:1200});await panel.getByRole("button",{name:"Authorize feedback deliveries",exact:true}).click();const dialog=page.getByRole("dialog");
   for(const [label,agent] of [["Planning agent",planner],["Reproduction agent",reproducer]] as const){await dialog.getByRole("combobox",{name:label,exact:true}).click();expect(await page.getByRole("option",{name:`Engineering fixture ${verifier.agentId}`,exact:true}).count()).toBe(0);await page.getByRole("option",{name:`Engineering fixture ${agent.agentId}`,exact:true}).click();}
   const action=dialog.getByRole("button",{name:"Authorize feedback deliveries",exact:true});await expect(action).toBeEnabled();await expect(action).toBeInViewport();expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);await dialog.screenshot({path:testInfo.outputPath(`feedback-work-dialog-${width}.png`)});
   if(width===1280)await dialog.getByRole("button",{name:"Close",exact:true}).click();else await action.click();
  }
  await expect.poll(()=>authorized).toBe(true);await expect(page.getByRole("dialog")).not.toBeVisible();
 }finally{await api.cleanup();await context.close();await browser.close();}
});
