import {chromium,expect,test} from "@playwright/test";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {TestApiClient} from "./fixtures";

test("supplemental records retain database identity and original files across reload and narrow layouts",async({baseURL},testInfo)=>{
 test.setTimeout(120000);test.skip(!process.env.MULTICA_ENGINEERING_BROWSER,"An explicit browser is required");
 const api=new TestApiClient();await api.loginLocally();const workspace=(await api.getWorkspaces()).find(row=>row.slug==="loopwork-local")!;
 const browser=await chromium.launch({executablePath:process.env.MULTICA_ENGINEERING_BROWSER}),context=await browser.newContext({viewport:{width:1280,height:1100},locale:"en-US"});
 await context.addInitScript(()=>localStorage.setItem("multica:chat:isOpen","false"));
 try{
  const page=await context.newPage(),hash="a".repeat(64),db1="b".repeat(64),db2="c".repeat(64),fileID="d".repeat(64),bytes=Buffer.from('Original prompt, retained as history.\n![reference](https://supplement-image.invalid/old.png)\n'),sha=createHash('sha256').update(bytes).digest('hex');
  const envelope={historical_only:true,execution_authorized:false,hash,archive_hash:"e".repeat(64)},databases=[{id:db1,path:"old-one/loop-ui.db",kind:"historical_business_database",available:true,task_count:1,additional_task_count:1},{id:db2,path:"old-two/loop-ui.db",kind:"historical_business_database",available:true,task_count:1,additional_task_count:1}],file={id:fileID,path:"agent-runtime/projects/old-project/agents/developer/PROMPT.md",bytes:bytes.length,sha256:sha,category:"generated_prompt_memory_history",origin:{project_id:"old-project",agent_id:"developer"}};
  let images=0;const errors:string[]=[];page.on('request',request=>{if(request.url().includes('supplement-image.invalid'))images++;});page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/engineering/history**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/availability')){await route.fulfill({json:{enabled:true,supplement:{enabled:true,hash}}});return;}
   if(url.pathname.endsWith('/supplement')){await route.fulfill({json:{...envelope,databases,files:[file]}});return;}
   if(url.pathname.includes('/supplement/files/')){const offset=Number(url.searchParams.get('offset')||0),length=Number(url.searchParams.get('length')||65536),part=bytes.subarray(offset,offset+length);await route.fulfill({json:{...envelope,file,offset,byte_length:part.length,data_base64:part.toString('base64'),eof:offset+part.length===bytes.length}});return;}
   const source=url.pathname.includes(db2)?databases[1]:databases[0],task={id:"same-task",title:source.id===db1?"First backup goal":"Second backup goal",status:"ready_to_close",additional:true};
   if(url.pathname.includes('/documents/')){await route.fulfill({json:{...envelope,database:source,task_id:task.id,document:{id:"same-doc",title:"Original document",kind:"review",revision:"1",content:source.path,raw:{content:source.path}}}});return;}
   if(url.pathname.endsWith('/same-task')){await route.fulfill({json:{...envelope,database:source,task:{...task,description:'Original obligation for '+source.path,raw:{task_id:task.id}},documents:[{id:"same-doc",title:"Original document",kind:"review",revision:"1"}]}});return;}
   if(url.pathname.includes('/supplement/databases/')){await route.fulfill({json:{...envelope,database:source,tasks:[task],offset:0,total:1,limit:50}});return;}
   await route.fulfill({json:{historical_only:true,source:{hash:"e".repeat(64),commit:"fixture",captured_at:"2026-11-17T00:00:00Z",name:"LoopWork"},projects:[],tasks:[],total:0,offset:0,limit:50}});
  });
  await page.goto(`${baseURL}/`);await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/issues`));await page.goto(`${baseURL}/${workspace.slug}/history?archive=supplement`);
  const panel=page.getByTestId('supplement-history');await expect(panel.getByRole('button',{name:/First backup goal/})).toBeVisible();
  await panel.getByRole('button',{name:/First backup goal/}).click();await expect(panel.getByRole('heading',{name:'First backup goal'})).toBeVisible();await expect(page).toHaveURL(new RegExp(`database=${db1}`));
  await panel.getByRole('button',{name:'Original document',exact:true}).click();await expect(panel.locator('article > pre')).toHaveText(databases[0].path);
  await panel.getByRole('combobox',{name:'Source database'}).selectOption(db2);await panel.getByRole('button',{name:/Second backup goal/}).click();await expect(panel.getByRole('heading',{name:'Second backup goal'})).toBeVisible();await expect(page).toHaveURL(new RegExp(`database=${db2}.*task=same-task`));await page.reload();await expect(panel.getByRole('heading',{name:'Second backup goal'})).toBeVisible();await expect(panel.getByText('Original obligation for old-two/loop-ui.db',{exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'Historical files (1)',exact:true}).click();await panel.getByRole('button',{name:new RegExp('PROMPT.md')}).click();await expect(panel.getByRole('heading',{name:file.path})).toBeVisible();
  await expect(panel.locator('pre')).toHaveText(bytes.toString());const pending=page.waitForEvent('download');await panel.getByRole('button',{name:'Download original file'}).click();const download=await pending;expect(await readFile((await download.path())!)).toEqual(bytes);
  for(const width of [1280,390]){await page.setViewportSize({width,height:1100});expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);await panel.screenshot({path:testInfo.outputPath(`supplement-file-${width}.png`),style:'nextjs-portal { visibility: hidden; }'});}
  await expect(panel.locator('img')).toHaveCount(0);expect(images).toBe(0);expect(errors).toEqual([]);await expect(panel.getByRole('button',{name:/start|run|done|save preparation/i})).toHaveCount(0);
 }finally{await context.close();await browser.close();}
});
