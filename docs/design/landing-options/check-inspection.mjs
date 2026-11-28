import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {privateNames} from './private-sources.mjs';
const output=fileURLToPath(new URL('../assets/inspection/',import.meta.url));
const records=JSON.parse(await readFile(output+'findings.json','utf8'));
const flight=JSON.parse(await readFile(output+'flight.json','utf8'));
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const page=await context.newPage();page.setDefaultTimeout(12000);
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`);});
async function ready(){await page.waitForFunction(()=>window.inspectionPreview?.getState().ready==='true');await page.evaluate(()=>document.fonts.ready);}
async function state(){return page.evaluate(()=>window.inspectionPreview.getState());}
async function load(file){await page.goto(`http://127.0.0.1:8766/landing-options/${file}`);await ready();}
async function layout(){const info=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,text:document.body.innerText,images:[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src)}));assert.ok(info.scroll<=info.width,`Overflow ${info.scroll}/${info.width}`);assert.deepEqual(privateNames(info.text),[],'Customer identity in visible page');await page.evaluate(async()=>Promise.all([...document.images].map(i=>i.decode())));}
try{
 await load('confined-spaces.html');await layout();assert.equal((await state()).scene.pointCount,280000);
 await page.getByRole('button',{name:'Transparent',exact:true}).click();assert.equal((await state()).scene.surface,'transparent');assert.equal(await page.locator('.section-settings').isVisible(),false);
 await page.getByRole('button',{name:'Complete',exact:true}).click();assert.equal((await state()).scene.surface,'complete');
 await page.getByRole('button',{name:'Cutaway',exact:true}).click();await page.locator('.cut-direction').selectOption('horizontal');await page.locator('.section-range').fill('4.2');assert.equal((await state()).scene.section,4.2);assert.equal((await state()).scene.direction,'horizontal');
 await page.locator('.section-range').press('ArrowRight');assert.equal((await state()).scene.section,4.3);
 await page.locator('.cut-direction').selectOption('vertical');await page.locator('[data-layer=scan]').check();await page.locator('[data-layer=model]').uncheck();assert.equal((await state()).scene.scanOn,true);assert.equal((await state()).scene.modelOn,false);
 await page.locator('.inspection-scene').scrollIntoViewIfNeeded();await page.screenshot({path:output+'confined-lidar-desktop.png'});
 await page.locator('[data-layer=model]').check();await page.locator('[data-layer=scan]').uncheck();await page.getByRole('button',{name:'Drone eye',exact:true}).click();await page.locator('.inspection-seek').fill('3');await page.locator('.inspection-scene').scrollIntoViewIfNeeded();
 const expected=flight.samples.find(s=>s.t===3).pos;
 await page.waitForFunction(expected=>window.inspectionPreview.getState().scene.position.every((v,i)=>Math.abs(v-expected[i])<.005),expected);
 await page.getByRole('button',{name:'Play inspection',exact:false}).click();await page.waitForFunction(()=>window.inspectionPreview.getState().scene.time>3.3);await page.getByRole('button',{name:'Pause inspection',exact:false}).click();
 await page.getByRole('button',{name:'Follow',exact:true}).click();assert.equal((await state()).scene.view,'follow');await page.getByRole('button',{name:'Reset view',exact:false}).click();assert.equal((await state()).scene.view,'orbit');
 await page.locator('.inspection-scene').scrollIntoViewIfNeeded();await page.screenshot({path:output+'confined-desktop.png'});
 await page.getByRole('button',{name:'F02: Top plate patch damage',exact:true}).click();assert.equal((await state()).selected,'F02');await page.locator('.selected-evidence').click();await ready();assert.equal((await state()).selected,'F02');
 console.log('Confined-space explorer passed: section, transparency, layers, real pose linkage, playback, follow and finding navigation.');
 await page.locator('#severity-filter').selectOption('4');assert.equal(await page.locator('.finding-item').count(),2);
 await page.locator('#finding-search').fill('no matching observation');assert.equal(await page.locator('.finding-item').count(),0);assert.equal(await page.locator('.empty-results').count(),1);
 await page.locator('#severity-filter').selectOption('0');await page.locator('#finding-search').fill('corrosion');assert.equal(await page.locator('.finding-item').count(),1);await page.locator('.finding-item').click();assert.equal((await state()).selected,'F05');
 await page.locator('.finding-photo').evaluate(i=>i.decode());await page.locator('[data-annotation=point]').click();await page.locator('.photo-stage').press('Enter');assert.equal((await state()).draftCount,1);await page.locator('.undo-annotation').click();assert.equal((await state()).draftCount,0);
 await page.locator('[data-annotation=box]').click();const box=await page.locator('.photo-stage').boundingBox();await page.mouse.move(box.x+box.width*.2,box.y+box.height*.3);await page.mouse.down();await page.mouse.move(box.x+box.width*.45,box.y+box.height*.5,{steps:5});await page.mouse.up();assert.equal((await state()).draftCount,1);
 await page.locator('.zoom-photo').click();assert.equal(await page.locator('.photo-stage').getAttribute('data-zoom'),'true');await page.locator('.zoom-photo').click();
 await page.locator('.mark-reviewed').click();assert.ok((await state()).reviewed.includes('F05'));
 await page.locator('.measure-target').selectOption('F01');const a=records.find(f=>f.id==='F05'),b=records.find(f=>f.id==='F01');const distance=Math.hypot(...a.position.map((p,i)=>p-b.position[i]));assert.equal(await page.locator('.measurement-result').textContent(),`${distance.toFixed(3)} m`);
 await page.locator('#finding-search').fill('');await page.locator('[data-finding=F09]').click();await page.locator('.include-report').check();assert.ok((await state()).included.includes('F09'));await page.locator('.finding-photo').evaluate(i=>i.decode());await page.locator('.evidence-workspace').scrollIntoViewIfNeeded();await page.screenshot({path:output+'evidence-desktop.png'});
 await page.locator('.product-nav').getByRole('link',{name:'Reports & handover',exact:true}).click();await ready();assert.ok((await state()).reviewed.includes('F05'));assert.equal(await page.locator('.report-rows tr').count(),4);
 console.log('Evidence explorer passed: filters and empty states, cross-view selection, photo zoom, draft point/box/undo, source-coordinate measurement and session review.');
 await page.locator('.next-evidence').click();assert.equal(await page.locator('.evidence-page-number').textContent(),'2 / 4');await page.locator('.previous-evidence').click();
 await page.locator('[data-section=summary]').uncheck();assert.equal(await page.locator('.sample-summary').isVisible(),false);await page.locator('[data-section=summary]').check();
 const downloadPromise=page.waitForEvent('download');await page.locator('.download-csv').click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'stratlas-sample-findings.csv');const csv=await readFile(await download.path(),'utf8');assert.equal(csv.trim().split('\r\n').length,5);assert.ok(csv.includes('F09'));assert.ok(csv.includes('F05'));assert.deepEqual(privateNames(csv),[]);
 for(const i of await page.locator('[data-include]').all())await i.uncheck();assert.equal(await page.locator('.report-empty').isVisible(),true);assert.equal(await page.locator('.download-csv').isDisabled(),true);
 await page.locator('[data-include=F01]').check();await page.locator('[data-include=F02]').check();await page.locator('[data-include=F05]').check();await page.locator('.report-workspace').scrollIntoViewIfNeeded();await page.screenshot({path:output+'reporting-desktop.png'});
 await page.locator('[data-package="LiDAR scan"]').uncheck();assert.ok(!(await page.locator('.package-result').textContent()).includes('LiDAR scan'));
 console.log('Report builder passed: carried selection, sections, pagination, empty state, CSV contents and package scope.');
 for(const file of ['confined-spaces.html','evidence.html','reporting.html']){
  await page.setViewportSize({width:390,height:844});await load(file);await layout();
  await page.getByRole('button',{name:'Explore',exact:false}).click();assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'),'true');assert.equal(await page.locator('#site-navigation').isVisible(),true);await page.locator('.menu-toggle').click();
  await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:output+file.replace('.html','')+'-mobile.png'});
  const lab=page.locator('.tank-workspace,.evidence-workspace,.report-workspace');await lab.scrollIntoViewIfNeeded();await layout();
 }
 await page.emulateMedia({reducedMotion:'reduce'});await load('confined-spaces.html');assert.equal(await page.locator('.inspection-video').evaluate(v=>v.paused),true);
 assert.deepEqual(errors,[]);console.log('All three pages passed mobile layout, navigation, image loading, visible-identity checks and reduced-motion checks. No browser or HTTP errors.');
}finally{await browser.close();}
