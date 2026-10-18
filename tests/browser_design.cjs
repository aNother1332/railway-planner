/* Verify the redesign preserves released controls and works at narrow widths. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const data=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures',name),'utf8'));
const result=data('wizard_result.json'),controls=data('v1.1_form_controls.json');
const alignment=JSON.parse(fs.readFileSync(path.join(__dirname,'../web/art/train-alignment.json'),'utf8'));
const base=process.env.RAIL_APP_URL||'http://127.0.0.1:8765',out=process.env.RAIL_SCREENSHOT_DIR;
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/config',r=>r.fulfill({json:{today:'2026-10-17',sale_end:'2026-10-31',now:'2026-10-17T23:00',version:'1.1.0'}}));
 await page.route('**/api/search',r=>r.fulfill({status:202,json:{id:'design-check'}}));
 let complete=false;
 await page.route('**/api/search/*',r=>r.fulfill({json:{status:complete?'complete':'running',progress:complete?100:65,message:complete?'查询完成':'正在核验票价',result,events:[{sequence:1,type:'hub',station:'HGH',city:'杭州'},{sequence:2,type:'verify',stops:['IOQ','HGH','HGH','NKH']}]}}));
 const shot=async name=>{if(out){await page.waitForTimeout(300);await page.screenshot({path:path.join(out,name+'.png'),fullPage:false});}};
 const nav=n=>page.locator(`.step-nav [data-step="${n}"]`);
 const noOverflow=async label=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label);
 await page.goto(base+'/#'+new URLSearchParams({q:JSON.stringify({origin:'深圳北站',destination:'南京南站',earliest:'2026-10-18T18:00',latest:'2026-10-19T18:00'})}));
 await page.waitForFunction(()=>!document.getElementById('next-preferences').disabled);
 await page.waitForFunction(()=>document.querySelectorAll('#map-preview-svg path').length>30);
 for(const selector of controls)assert.equal(await page.locator(selector).count(),1,'Released control missing or duplicated: '+selector);
 await page.waitForFunction(()=>document.querySelector('.sketch-scene').classList.contains('is-ready'));
 await page.waitForTimeout(550);
 assert.equal(await page.locator('.brand,.site-header').count(),0,'Page-header branding was removed');
 assert.equal(await page.locator('.trip-fields #history-btn').count(),1);
 assert.ok((await page.locator('#history-btn').boundingBox()).y>(await page.locator('#date').boundingBox()).y);
 const assertWheelAlignment=async()=>{
  const points=await page.locator('.scene-train').evaluate((image,layout)=>{
   const css=getComputedStyle(image),matrix=new DOMMatrixReadOnly(css.transform);
   const origin=css.transformOrigin.split(' ').map(parseFloat);
   const travel=new DOMMatrixReadOnly(getComputedStyle(image.parentElement).transform);
   const ratio=image.clientWidth/layout.canvas[0];
   return layout.wheelContacts.map(([x,y])=>{
    const point=matrix.transformPoint({x:x*ratio-origin[0],y:y*ratio-origin[1]});
    return [(point.x+origin[0]+travel.m41)/ratio,(point.y+origin[1]+travel.m42)/ratio];
   });
  },alignment);
  for(const [x,y] of points){
   assert.ok(Math.abs(y-(alignment.track.intercept+alignment.track.slope*x))<2,'Wheel sample leaves straight track baseline');
   assert.ok(x>alignment.track.straightRange[0]&&x<alignment.track.straightRange[1],'Train must stay within straight section');
  }
 };
 await assertWheelAlignment();
 const landBefore=await page.locator('.scene-landscape').boundingBox();
 await page.mouse.move(50,500);await page.waitForTimeout(500);
 const left=await page.locator('.scene-train-carriage').evaluate(e=>new DOMMatrixReadOnly(getComputedStyle(e).transform).m41);
 await assertWheelAlignment();await shot('直轨-鼠标左侧');
 const landLeft=await page.locator('.scene-landscape').boundingBox();
 const trainLeft=await page.locator('.scene-train').boundingBox();
 await page.mouse.move(1390,500);await page.waitForTimeout(500);
 const right=await page.locator('.scene-train-carriage').evaluate(e=>new DOMMatrixReadOnly(getComputedStyle(e).transform).m41);
 await assertWheelAlignment();await shot('直轨-鼠标右侧');
 const landRight=await page.locator('.scene-landscape').boundingBox();
 const trainRight=await page.locator('.scene-train').boundingBox();
 assert.ok(left<0&&right>0&&Math.abs(left)<=8&&Math.abs(right)<=8,'Train follows mouse direction within its rail-travel bound');
 assert.ok(landLeft.x<landBefore.x&&landRight.x>landBefore.x,'Background should move gently with the pointer');
 const backgroundTravel=landRight.x-landLeft.x,trainTravel=trainRight.x-trainLeft.x;
 assert.ok(backgroundTravel<=8.1&&backgroundTravel>5,'Background horizontal range stays small');
 assert.ok(trainTravel>backgroundTravel*2.5,'Train must move visibly more than background');
 const tangent=await page.locator('.scene-train-carriage').evaluate(e=>{const m=new DOMMatrixReadOnly(getComputedStyle(e).transform);return {x:m.m41,y:m.m42};});
 assert.ok(Math.abs(tangent.y+.2*tangent.x)<.004,'Additional train travel follows the rail tangent');
 await page.mouse.move(720,500);await page.waitForTimeout(650);
 await shot('新版-01-行程');
 await page.locator('#next-preferences').focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator('#step-2').evaluate(e=>e.getAnimations().length),0,'Keyboard navigation must not introduce moving surfaces');
 assert.deepEqual(await page.locator('[data-mode]').allTextContents(),['均衡推荐','价格优先','总耗时短','夜间卧铺']);
 await shot('新版-02-偏好');
 await page.locator('#preferences summary').first().click();await page.locator('.stay-details summary').click();
 await shot('新版-高级偏好');
 await page.locator('#preferences summary').first().click();
 await page.locator('#search-button').click();await page.waitForFunction(()=>document.querySelectorAll('#query-map .query-link').length===2);
 await page.waitForTimeout(1600);await shot('新版-03-查询');
 complete=true;await page.locator('#step-4').waitFor({state:'visible'});await shot('新版-04-路线');
 await page.locator('[data-detail]').first().click();await shot('新版-路线详情');
 await page.locator('[data-detail]').first().click();
 await page.locator('[data-compare]').nth(0).check();await page.locator('[data-compare]').nth(1).check();
 await shot('新版-路线对比入口');
 await page.locator('#clear-compare').click();
 for(const width of [320,390,540,768,1024,1440]){
  await page.setViewportSize({width,height:900});
  for(const step of [1,2,3,4]){
   await nav(step).click();if(step===1)await assertWheelAlignment();await noOverflow(`Overflow at ${width}px on step ${step}`);
   if(step===2){await page.locator('#preferences summary').first().click();await noOverflow(`Advanced overflow at ${width}px`);await page.locator('#preferences summary').first().click();}
  }
 }
 await page.setViewportSize({width:390,height:844});
 await nav(1).click();await shot('新版-手机行程');
 const fontSizes=await page.locator('#origin,#destination,#date').evaluateAll(inputs=>inputs.map(e=>parseFloat(getComputedStyle(e).fontSize)));
 assert.ok(fontSizes.every(size=>size>=16),'Mobile inputs should not trigger browser auto-zoom');
 await nav(2).click();await shot('新版-手机偏好');await nav(4).click();await shot('新版-手机路线');
 await page.locator('[data-detail]').first().click();await noOverflow('Mobile expanded detail overflow');
 await nav(1).click();await page.locator('#open-map').click();
 await page.waitForFunction(()=>document.getElementById('rail-map').dataset.cameraMoving==='false');await shot('新版-手机地图');
 const done=await page.locator('#map-done').boundingBox();assert.ok(done.y+done.height<=844);
 await page.locator('#close-map').click();await page.emulateMedia({reducedMotion:'reduce'});
 await nav(2).click();assert.equal(await page.locator('#step-2').evaluate(e=>e.getAnimations().length),0);
 assert.equal(await page.locator('.sketch-scene').evaluate(e=>e.getAnimations({subtree:true}).length),0,'Reduced motion must stop background animation');
 await page.mouse.move(10,500);await page.waitForTimeout(150);
 assert.equal(await page.locator('.scene-train-carriage').evaluate(e=>new DOMMatrixReadOnly(getComputedStyle(e).transform).m41),0,'Reduced motion must keep the train still');
 const reducedLand=await page.locator('.scene-landscape').boundingBox();
 await page.mouse.move(380,400);await page.waitForTimeout(150);
 assert.deepEqual(await page.locator('.scene-landscape').boundingBox(),reducedLand,'Reduced motion must also keep scenery still');
 assert.deepEqual(errors,[]);await browser.close();
 console.log('DESIGN PASSED: all v1.1 controls preserved; four screens at 320/390/540/768/1024/1440px; advanced options, keyboard/reduced motion, mobile input sizes, straight-track wheel alignment, layered parallax and map actions');
})().catch(error=>{console.error(error);process.exit(1);});
