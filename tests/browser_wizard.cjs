/* Browser regressions replay a recorded official result; no upstream queries.
   PLAYWRIGHT_MODULE can point to a separately installed Playwright module. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const result=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/wizard_result.json'),'utf8'));
const base=process.env.RAIL_APP_URL || 'http://127.0.0.1:8765';
const out=process.env.RAIL_SCREENSHOT_DIR;

(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:900},permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  let scenario='pending',released=false,posts=0,cancelled=[],latePost=null,postPayloads=[];
  await page.route('**/api/config',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({today:'2026-10-17',sale_end:'2026-10-31',now:'2026-10-17T23:00',version:'1.0.0'})}));
  await page.route('**/api/search',async r=>{
    const id='ui-job-'+(++posts);postPayloads.push(r.request().postDataJSON());
    if(scenario==='late-post')await new Promise(resolve=>latePost=resolve);
    await r.fulfill({status:202,contentType:'application/json',body:JSON.stringify({id})});
  });
  await page.route('**/api/search/*',r=>{
    const status=scenario==='error'?'error':scenario==='pending'&&!released?'running':'complete';
    const data={status,progress:status==='running'?42:100,message:status==='running'?'正在组合中转路线':'查询完成',error:'测试连接失败',result:scenario==='empty'?{...result,routes:[],highlights:{},empty_hint:'未找到满足条件的路线。'}:result};
    return r.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.route('**/api/cancel/*',r=>{cancelled.push(r.request().url().split('/').at(-1));return r.fulfill({contentType:'application/json',body:'{"cancelled":true}'});});
  const nav=n=>page.locator('.step-nav [data-step="'+n+'"]');
  async function visible(n){await page.locator('#step-'+n).waitFor({state:'visible'});assert.equal(await page.locator('.step-page:visible').count(),1);}
  async function shot(name){if(out)await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});}
  await page.goto(base);
  await page.waitForFunction(()=>!document.getElementById('next-preferences').disabled);
  await visible(1);
  assert.equal(await page.locator('.intro-art,.welcome,.highlight-grid').count(),0);
  await shot('转个弯-步骤1-行程');
  await page.locator('#next-preferences').click();await visible(1);
  await page.locator('#origin').fill('深圳');await page.locator('#origin').press('Escape');
  await page.locator('#destination').fill('南京');await page.locator('#destination').press('Escape');
  await page.locator('#next-preferences').click();await visible(2);
  assert.ok((await page.locator('[data-trip-summary]').textContent()).includes('深圳 → 南京'));
  await page.locator('[data-mode=sleeper]').click();await page.locator('#sleep-options').waitFor({state:'visible'});
  await page.locator('#time').fill('18:00');await page.locator('#latest').fill('2026-10-19T14:00');
  await page.locator('#preferences summary').first().click();
  await page.locator('#budget').fill('900');
  assert.ok((await page.locator('#advanced-count').textContent()).includes('1'));
  await page.locator('#preferences summary').first().click();
  assert.equal(await page.locator('#budget').inputValue(),'900');
  // Invalid nested advanced inputs reopen their ancestors for correction.
  await page.locator('#preferences summary').first().click();
  await page.locator('.stay-details summary').click();
  await page.locator('#stay-min').fill('-1');
  await page.locator('#preferences summary').first().click();
  await page.locator('#search-button').click();await visible(2);
  assert.equal(await page.locator('#stay-min').isVisible(),true);
  assert.equal(posts,0);
  await page.locator('#stay-min').fill('');
  await page.locator('#preferences summary').first().click();
  await shot('转个弯-步骤2-偏好');
  await page.locator('#search-button').click();await visible(3);
  await page.waitForFunction(()=>document.getElementById('progress').value===42);
  await shot('转个弯-步骤3-查询');
  await nav(1).click();await visible(1);
  assert.equal(await page.locator('#destination').inputValue(),'南京');
  await nav(2).click();await visible(2);
  assert.equal(await page.locator('#budget').inputValue(),'900');
  await nav(3).click();await visible(3);
  assert.equal(cancelled.length,0,'Viewing prior pages must not cancel a query');
  released=true;await visible(4);
  assert.equal(await page.locator('.route-card').count(),result.routes.length);
  assert.equal(await page.locator('.highlight').count(),0);
  await shot('转个弯-步骤4-路线');
  const firstCard=page.locator('.route-card').first();
  await firstCard.locator('[data-detail]').click();
  await firstCard.locator('.route-detail').waitFor({state:'visible'});
  assert.equal(await page.locator('#detail-dialog').isVisible(),false,'Route details should expand inline');
  assert.ok((await firstCard.locator('.booking-link').first().getAttribute('href')).includes('12306.cn'));
  await firstCard.locator('[data-copy-itinerary]').click();
  assert.ok((await page.evaluate(()=>navigator.clipboard.readText())).includes('成人火车票合计'));
  await firstCard.locator('[data-detail]').click();
  await page.locator('[data-compare]').nth(0).check();await page.locator('[data-compare]').nth(1).check();
  await page.locator('#open-compare').click();await page.locator('#detail-dialog').waitFor({state:'visible'});
  await page.locator('#detail-dialog .close-dialog').click();
  await nav(2).click();assert.equal(await page.locator('#compare-bar').isVisible(),false);
  await nav(4).click();await visible(4);assert.equal(await page.locator('#compare-bar').isVisible(),true);
  await nav(3).click();await visible(3);
  assert.ok((await page.locator('#progress-heading').textContent()).includes('已完成'));
  await page.locator('#view-results').click();await visible(4);
  await page.goBack();await visible(3);await page.goForward();await visible(4);
  await page.locator('#share').click();assert.ok((await page.evaluate(()=>navigator.clipboard.readText())).includes('#q='));
  // Editing a completed query invalidates old results.
  await nav(2).click();await page.locator('[data-mode=price]').click();
  assert.equal(await nav(4).isDisabled(),true);
  assert.equal(await page.locator('.route-card').count(),0);
  await nav(3).click();await visible(3);
  assert.equal(await page.locator('#progress-heading').textContent(),'条件已修改');
  assert.equal(await page.locator('#view-results').isVisible(),false);
  await nav(2).click();
  // Browsing does not cancel, but changing a field during a query does.
  scenario='pending';released=false;
  await page.locator('#search-button').click();await visible(3);
  await nav(1).click();await page.locator('#destination').fill('上海');await page.locator('#destination').press('Escape');
  await page.waitForFunction(()=>document.getElementById('search-button').textContent==='开始寻找路线');
  assert.ok(cancelled.length>0);released=true;await page.waitForTimeout(950);await visible(1);
  assert.equal(await nav(4).isDisabled(),true,'Late completion must not restore stale results');
  // A delayed POST reply must also be cancelled after editing.
  await nav(2).click();scenario='late-post';latePost=null;
  await page.locator('#search-button').click();await visible(3);
  await page.waitForFunction(()=>document.getElementById('progress').value===0);
  while(!latePost)await page.waitForTimeout(10);
  await nav(1).click();await page.locator('#origin').fill('广州');await page.locator('#origin').press('Escape');
  const pendingId='ui-job-'+posts;latePost();
  for(let i=0;i<30&&!cancelled.includes(pendingId);i++)await page.waitForTimeout(30);
  assert.ok(cancelled.includes(pendingId),'A superseded POST must cancel its returned job');
  await visible(1);
  // Failures stay on the progress page; retry succeeds and empty results get their own page.
  await nav(2).click();scenario='error';
  await page.locator('#search-button').click();await visible(3);await page.locator('#progress-error').waitFor({state:'visible'});
  scenario='empty';await page.locator('#retry-button').click();await visible(4);await page.locator('#empty-state').waitFor({state:'visible'});
  await page.locator('#relax').click();await visible(2);
  scenario='complete';await page.locator('#search-button').click();await visible(4);
  // Mobile layout on every screen; empty input and historical links restore gracefully.
  await page.setViewportSize({width:390,height:844});
  for(const n of [1,2,3,4]){await nav(n).click();await visible(n);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Horizontal overflow on step '+n);}
  await shot('转个弯-手机版-路线');
  await nav(1).click();await page.locator('#history-btn').click();await page.locator('.history-item').first().click();await visible(1);
  assert.equal(await nav(4).isDisabled(),true);
  // Existing shared conditions restore to step one without starting a request.
  const previousPosts=posts;
  const shared={origin:'南京',destination:'哈尔滨',earliest:'2026-10-18T18:00',latest:'2026-10-19T18:00',mode:'sleeper',early_policy:'prefer'};
  await page.goto(base+'/#'+new URLSearchParams({q:JSON.stringify(shared)}));
  await page.reload();
  await page.waitForFunction(()=>!document.getElementById('next-preferences').disabled);
  await visible(1);assert.equal(await page.locator('#origin').inputValue(),'南京');assert.equal(await page.locator('#destination').inputValue(),'哈尔滨');
  await page.locator('#next-preferences').click();await visible(2);
  assert.equal(await page.locator('#time').inputValue(),'18:00');assert.equal(posts,previousPosts);
  assert.ok(postPayloads.every(p=>Array.isArray(p.seats)&&typeof p.early_policy==='string'));
  assert.deepEqual(errors,[]);
  await browser.close();console.log('WIZARD PASSED: four screens, navigation, input preservation, inline details, compare/share/history, edit cancellation, delayed POST, stale responses, retry/empty state and mobile');
})().catch(error=>{console.error(error);process.exit(1);});
