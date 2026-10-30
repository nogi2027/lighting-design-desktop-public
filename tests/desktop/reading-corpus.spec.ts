import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const corpus=process.env.LX_DESKTOP_CORPUS;
test.skip(!corpus,'Set LX_DESKTOP_CORPUS to the local reading corpus.');
test.setTimeout(1_800_000);
type Case={id:string;title:string;kind:string;expectedText:string;family:string};
let app:ElectronApplication,page:Page;
const normal=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/);
test('corpus import, formatting, source anchors and marker packing',async()=>{
 const userData=await fs.mkdtemp(path.join(os.tmpdir(),'lx-reading-corpus-'));
 app=await _electron.launch({args:['.'],env:{...process.env,LX_DESKTOP_USER_DATA:userData,LX_DESKTOP_TEST_HIDE_WINDOWS:'1'}});
 page=await app.firstWindow();page.setDefaultTimeout(15_000);
 const errors:string[]=[],external:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url());});
 const cases:Case[]=JSON.parse(await fs.readFile(path.join(corpus!,'catalog.json'),'utf8'));
 const results:unknown[]=[];
 try{
  for(const item of cases){await test.step(item.id,async()=>{
   await page.getByRole('button',{name:item.title,exact:false}).click();
   await expect(page.getByRole('heading',{name:'Set up your script'})).toBeVisible({timeout:180_000});
   await page.getByRole('button',{name:'Create show',exact:true}).click();
   await expect(page.locator('.formatted-script').first()).toBeVisible({timeout:30_000});
   const reading=await page.evaluate(async()=>fetch('/script/reading.json').then(r=>r.json()));
   const extracted=reading.lines.map((l:{text:string})=>l.text).join(' ');
   const expectedWords=normal(item.expectedText),actualWords=new Set(normal(extracted));
   const recall=expectedWords.filter(w=>actualWords.has(w)).length/expectedWords.length;
   const wordCount=reading.lines.reduce((n:number,l:{words:unknown[]})=>n+l.words.length,0);
   const runs=reading.lines.flatMap((l:{runs:unknown[]})=>l.runs);
   const stats={id:item.id,kind:item.kind,pages:reading.pages.length,wordCount,recall,bold:runs.filter((r:{bold?:boolean})=>r.bold).length,italic:runs.filter((r:{italic?:boolean})=>r.italic).length,highlights:runs.filter((r:{highlight?:string})=>r.highlight).length,columns:reading.items.filter((n:{kind:string})=>n.kind==='parallel').length};
   results.push(stats);console.log(JSON.stringify(stats));
   await fs.mkdir('artifacts/reading-corpus',{recursive:true});
   await fs.writeFile(`artifacts/reading-corpus/${item.id}.json`,JSON.stringify(reading));
   await fs.writeFile('artifacts/reading-corpus/results.json',JSON.stringify(results,null,2));
   expect(wordCount).toBeGreaterThan(10);
   if(item.family==='controlled') expect(recall,item.id+' source-word recall').toBeGreaterThan(item.kind==='digital'?.99:.9);
   if(item.kind==='digital' && item.id==='layout-mixed-emphasis'){expect(stats.bold).toBeGreaterThan(5);expect(stats.italic).toBeGreaterThan(5);}
   if(item.id==='layout-highlight' || item.id==='layout-highlight-scan')expect(stats.highlights).toBeGreaterThanOrEqual(16);
   if(item.id==='layout-columns')expect(stats.columns).toBe(1);
   if(item.kind==='scan-with-text')expect(reading.pages.every((p:{ocr?:boolean})=>p.ocr)).toBe(true);
   if(item.family==='published')expect(recall,item.id+' reference passage').toBeGreaterThan(.85);
   if(['layout-serif','layout-mixed-emphasis-scan','layout-columns-scan'].includes(item.id)) {
    const words=page.locator('.formatted-script').first().locator('.reader-word');
    const textBefore=await words.allTextContents();
    for(let i=0;i<4;i++){
     await page.getByRole('button',{name:'New cue',exact:true}).click();
     await words.nth(13+i).click();
     await page.getByRole('button',{name:'Word cue',exact:true}).click();
     await expect(page.getByLabel('Editable cue title')).toBeVisible();
     await page.getByLabel('Editable cue title').fill(`Packing check ${i+1}`);
     await expect.poll(()=>page.evaluate(()=>window.desktopFlush?.())).toBe(true);
     await page.getByRole('button',{name:'Done editing',exact:true}).click();
    }
    await expect(page.locator('.formatted-script').first().locator('.reader-cue-marker')).toHaveCount(4);
    expect(await words.allTextContents()).toEqual(textBefore);
    await page.screenshot({path:`artifacts/reading-corpus/${item.id}-cues.png`,fullPage:false});
    const overlap=await page.locator('.formatted-script').first().evaluate(root=>{
     const shapes=[...root.querySelectorAll('.reader-marker-shape')].map(e=>e.getBoundingClientRect());
     const text=[...root.querySelectorAll('.reader-word')].map(e=>e.getBoundingClientRect());
     return shapes.some(a=>text.some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>2 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>2));
    });
    expect(overlap,'cue badges must not cover script text').toBe(false);
    if(item.id==='layout-serif'){
     const file=path.resolve('artifacts/reading-corpus/marker-demo.lxshow');
     await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},file);
     await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('desktop-command','save'));
     await expect.poll(async()=>fs.stat(file).then(s=>s.size).catch(()=>0)).toBeGreaterThan(10000);
     await page.evaluate(file=>window.desktop.openShow(file),file);await page.reload();
     await expect(page.locator('.formatted-script').first().locator('.reader-cue-marker')).toHaveCount(4);
    }
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByLabel('Script font size').selectOption('22');
    await page.getByLabel('Script typeface').selectOption('sans');
    await page.getByRole('button',{name:'Close settings'}).click();
    await expect.poll(()=>words.nth(13).locator('span[style]').first().evaluate(element=>getComputedStyle(element).fontFamily)).toMatch(/Arial/);
    await page.setViewportSize({width:850,height:800});
    await page.waitForTimeout(250);
    expect(await words.allTextContents()).toEqual(textBefore);
    await page.setViewportSize({width:1280,height:900});
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByLabel('Script typeface').selectOption('source');
    await page.getByLabel('Script font size').selectOption('16');
    await page.getByRole('button',{name:'Close settings'}).click();
   }
   expect(errors.splice(0)).toEqual([]);expect(external).toEqual([]);
   await page.getByRole('button',{name:'Choose test script',exact:true}).click();
   await expect(page.locator('.example-card')).toHaveCount(cases.length);
  });}
 }finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
});
