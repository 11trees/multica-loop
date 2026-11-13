import {test,expect,chromium} from '@playwright/test';
import {TestApiClient} from './fixtures';

test('a long requirement report remains readable and actionable after narrow-layout navigation',async({baseURL},testInfo)=>{
  test.skip(!process.env.MULTICA_ENGINEERING_BROWSER,'Requires an explicit browser binary');
  const api=new TestApiClient();await api.loginLocally();const workspace=(await api.getWorkspaces()).find(w=>w.slug==='loopwork-local')!;api.setWorkspaceId(workspace.id);api.setWorkspaceSlug(workspace.slug);
  const issue=await api.createIssue('Long requirement report layout fixture');
  const browser=await chromium.launch({executablePath:process.env.MULTICA_ENGINEERING_BROWSER}),context=await browser.newContext({viewport:{width:1280,height:1600}});
  const report=['# Requirement closure report','Review 2','Original obligations and forwarded evidence gaps are closed',...['outcome','scope','implementation','verification','risks'].map(kind=>`## ${kind}\n\nCurrent ${kind}: original Ready and Continue behavior is bound to the accepted commits and independent browser observations. The prior review gap and follow-up remain traceable.`),'## Evidence boundary\n\nExact frozen independent verification references and final commit; no external deployment coverage','## Residual risk\n\nPackaged deployments remain outside this local fixture'].join('\n\n');
  const overview={enabled:true,configured:true,chain:'review',agent_id:'reviewer',revision:1,sequence:25,status:'completed',has_active_run:false,questions:[],requirement:{kind:'requirement',input:'Original fixture',context:null,plan:null,review_enabled:true,review:{generation:2,draft_id:'review',agent_id:'reviewer',report_hash:'a'.repeat(64),acknowledgement:null as null | {userId:string;reportHash:string;sequence:number;acknowledgedAt:string},result:{verdict:'report_ready',report,gaps:[],units:[]},history:[]}}};
  try{
    const page=await context.newPage();await page.route(`**/api/issues/${issue.id}/engineering`,route=>route.fulfill({json:overview}));
    await page.goto(`${baseURL}/`);await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/issues$`));await page.goto(`${baseURL}/${workspace.slug}/issues/${issue.id}`);
    const panel=page.getByRole('region',{name:'Engineering delivery'}),button=panel.getByRole('button',{name:'I have read it; close requirement',exact:true});await expect(button).toBeEnabled();
    await page.setViewportSize({width:390,height:1200});await page.mouse.move(195,600);
    await expect.poll(async()=>{const box=await button.boundingBox();if(!box)return false;const visible=box.y>=60 && box.y+box.height<=1050;if(!visible)await page.mouse.wheel(0,box.y-600);return visible;}).toBe(true);
    await expect(button).toBeInViewport();expect(await panel.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await page.screenshot({path:testInfo.outputPath('review-reading-narrow.png')});
    let acknowledged=false;await page.route(`**/api/issues/${issue.id}/engineering/review/acknowledge`,async route=>{expect(route.request().postDataJSON()).toEqual({expected_revision:1,expected_sequence:25,report_hash:'a'.repeat(64)});acknowledged=true;overview.requirement.review.acknowledgement={userId:'human',reportHash:'a'.repeat(64),sequence:25,acknowledgedAt:new Date().toISOString()};await route.fulfill({json:{acknowledged:true}});});
    await button.click();await expect(panel.getByText('Reading confirmed for this report.',{exact:true})).toBeVisible();expect(acknowledged).toBe(true);
  }finally{await context.close();await browser.close();await api.cleanup();}
});
