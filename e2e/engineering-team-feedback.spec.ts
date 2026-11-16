import {chromium,expect,test} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {TestApiClient} from "./fixtures";

test("Team Feedback settings persist native roles and task feedback selects comments only",async({baseURL},testInfo)=>{
 test.setTimeout(180000);test.skip(process.env.MULTICA_ENGINEERING_ENABLED!=="true" || !process.env.MULTICA_ENGINEERING_BROWSER,"Managed engineering and an explicit browser are required");
 const api=new TestApiClient();await api.loginLocally();const workspace=(await api.getWorkspaces()).find(item=>item.slug==="loopwork-local")!;api.setWorkspaceId(workspace.id);api.setWorkspaceSlug(workspace.slug);
 const browser=await chromium.launch({executablePath:process.env.MULTICA_ENGINEERING_BROWSER}),context=await browser.newContext({viewport:{width:1280,height:1400}});context.setDefaultTimeout(20000);await context.addInitScript(()=>localStorage.setItem("multica:chat:isOpen","false"));
 try{
  const leader=await api.seedEngineeringRun(),runs=[leader];await api.finishEngineeringRun(leader.taskId);const team=await api.createWorkflowTeamFixture(leader.agentId);
  for(let index=1;index<8;index++){const run=await api.seedEngineeringRun(leader.issueId);runs.push(run);await api.finishEngineeringRun(run.taskId);await api.addWorkflowTeamAgentFixture(team.id,run.agentId)}
  const page=await context.newPage();await page.goto(`${baseURL}/`);await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/issues`));await page.goto(`${baseURL}/${workspace.slug}/squads/${team.id}`);
  const section=page.locator("section").filter({has:page.getByRole("heading",{name:"Working method",exact:true})});await section.getByRole("button",{name:"Set workflow",exact:true}).click();
  await section.getByRole("combobox",{name:"Workflow",exact:true}).click();await page.getByRole("option",{name:"Development delivery",exact:true}).click();
  const choose=async(label:string,index:number)=>{await section.getByRole("combobox",{name:label,exact:true}).click();await page.getByRole("option",{name:`Engineering fixture ${runs[index]!.agentId}`,exact:true}).click()};
  for(const [index,label] of ["Context agent","Planning agent","Analysis agent","Development agent","Independent verification agent","Review agent"].entries())await choose(label,index);
  await section.getByRole("checkbox",{name:"Feedback",exact:true}).check();
  for(const [label,index] of [["Triage agent",0],["Feedback verification agent",7],["Planning agent",1],["Reproduction agent",6]] as const)await choose(`Feedback · ${label}`,index);
  await section.getByRole("button",{name:"Save",exact:true}).click();await expect.poll(async()=>(await api.readWorkflowTeamFixture(team.id)).profile?.revision).toBe(1);
  const profile=(await api.readWorkflowTeamFixture(team.id)).profile;expect(profile.definition.feedback).toEqual({triager:runs[0]!.agentId,verifier:runs[7]!.agentId,planner:runs[1]!.agentId,reproducer:runs[6]!.agentId});
  await page.reload();await expect(section.getByText("Feedback",{exact:true})).toBeVisible();
  for(const width of [1280,390]){await page.setViewportSize({width,height:1400});expect(await section.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);await section.screenshot({path:testInfo.outputPath(`team-feedback-settings-${width}.png`)})}

  const title="Team Feedback comment selection",issue=await api.createIssue(title,{status:"backlog",assignee_type:"squad",assignee_id:team.id}),comment=await api.createComment(issue.id,"Clarify the final reader action");
  const overview={enabled:true,configured:true,chain:"review",agent_id:runs[5]!.agentId,revision:1,sequence:20,status:"completed",has_active_run:false,feedback_allowed:true,questions:[],team:{id:team.id,revision:1,workflow:"develop",frozen:true,aligned:true,input:title,feedback_enabled:true},requirement:{kind:"requirement",input:title,context:null,plan:null,delivery_policy:{analystId:runs[2]!.agentId,developerId:runs[3]!.agentId,verifierId:runs[4]!.agentId,maxReworks:2,mode:"in_place",userId:"human"},feedback:{enabled:true,capture_ready:true,active:false,unresolved_count:0,expected_batch_number:0,batches:[]},review:{current:true,generation:1,draft_id:"controlled-report",agent_id:runs[5]!.agentId,report_hash:"a".repeat(64),acknowledgement:null,result:{verdict:"report_ready",report:"# Controlled final report",gaps:[],units:[]},history:[]}}};
  await page.route(`**/api/issues/${issue.id}/engineering`,route=>route.fulfill({json:overview}));let submitted=false;
  await page.route(`**/api/issues/${issue.id}/engineering/feedback`,async route=>{const body=route.request().postDataJSON();expect(body).toEqual({request_id:expect.any(String),expected_revision:1,expected_sequence:20,expected_batch_number:0,comment_ids:[comment.id]});submitted=true;await route.fulfill({json:{configured:true,batch_id:randomUUID(),reopen_required:true}})});
  await page.goto(`${baseURL}/${workspace.slug}/issues/${issue.id}`);const panel=page.getByRole("region",{name:"Engineering delivery",exact:true});
  for(const width of [1280,390]){
   await page.setViewportSize({width,height:1200});await panel.getByRole("button",{name:"Process feedback",exact:true}).click();const dialog=page.getByRole("dialog");await expect(dialog.getByRole("combobox")).toHaveCount(0);await dialog.getByRole("checkbox").check();const submit=dialog.getByRole("button",{name:"Process feedback",exact:true});await expect(submit).toBeEnabled();await expect(submit).toBeInViewport();expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);await dialog.screenshot({path:testInfo.outputPath(`team-feedback-capture-${width}.png`)});
   if(width===1280)await dialog.getByRole("button",{name:"Close",exact:true}).click();else await submit.click();
  }
  await expect.poll(()=>submitted).toBe(true);await expect(page.getByRole("dialog")).toHaveCount(0);
 }finally{await context.close();await browser.close();await api.cleanup()}
});
