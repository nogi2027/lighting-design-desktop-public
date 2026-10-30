import { _electron, expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
test.skip(!process.env.LX_DESKTOP_CORPUS,'Local corpus required.');
test('local lab controls, compact card, and line/word cues survive large-text reflow',async()=>{
 const userData=await fs.mkdtemp(path.join(os.tmpdir(),'lx-lab-ui-'));
 const app=await _electron.launch({args:['.'],env:{...process.env,LX_DESKTOP_USER_DATA:userData,LX_DESKTOP_TEST_HIDE_WINDOWS:'1'}});
 const page=await app.firstWindow();page.setDefaultTimeout(15000);
 try{
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1280,height:900}));
  await page.getByRole('button',{name:'Serif · PDF'}).click();
  await expect(page.getByRole('heading',{name:'Set up your script'})).toBeVisible();
  await page.getByRole('button',{name:'Create show',exact:true}).click();
  const card=page.locator('.sticky-scene-row .aligned-scene-card').first();
  await expect(card).toBeVisible();
  await page.evaluate(()=>document.fonts.ready);
  const geometry=await card.evaluate(card=>{const bounds=card.getBoundingClientRect(),last=card.querySelector('em')!.getBoundingClientRect();return {height:bounds.height,bottomSpace:bounds.bottom-last.bottom,clipped:[...card.querySelectorAll('strong,em')].some(e=>{const r=e.getBoundingClientRect();return r.bottom>bounds.bottom+1 || r.top<bounds.top;})};});
  await page.screenshot({path:'artifacts/reading-corpus/compact-scene-card.png'});
  expect(geometry.height).toBeGreaterThan(35);expect(geometry.bottomSpace).toBeLessThan(18);expect(geometry.clipped).toBe(false);
  await page.getByRole('button',{name:'SHOW',exact:true}).click();
  await expect(page.getByRole('menuitem',{name:'Save show as…',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByRole('menu',{name:'Show files'})).toBeHidden();
  const words=page.locator('.formatted-script').first().locator('.reader-word');
  const before=await words.allTextContents();
  for(let i=0;i<4;i++){
   await page.getByRole('button',{name:'New cue',exact:true}).click();await words.nth(13+i).click();
   await page.getByRole('button',{name:i===0?'Line cue':'Word cue',exact:true}).click();
   await page.getByLabel('Editable cue title').fill(i===0?'Line cue':'Crowded word '+i);
   await page.getByRole('button',{name:'Assign next number',exact:true}).click();
   await page.getByLabel('Editable cue number').fill(String(12.125+i*.001));
   await page.getByLabel('Editable cue number').press('Enter');await page.getByLabel('Editable cue title').focus();
   await expect.poll(()=>page.evaluate(()=>window.desktopFlush?.())).toBe(true);
   await page.getByRole('button',{name:'Done editing',exact:true}).click();
  }
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.getByRole('button',{name:'Backup',exact:true})).toHaveCount(0);
  await page.getByLabel('Script font size').selectOption('26');await page.getByLabel('Script line spacing').selectOption('1.4');
  await page.getByRole('button',{name:'Close settings'}).click();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:850,height:800}));
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));});
  expect(await words.allTextContents()).toEqual(before);
  await expect.poll(()=>page.locator('.formatted-script').first().evaluate(root=>{
   const shapes=[...root.querySelectorAll('.reader-marker-shape')].map(e=>e.getBoundingClientRect());
   const text=[...root.querySelectorAll('.reader-word')].map(e=>e.getBoundingClientRect());
   return shapes.some(a=>text.some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>2&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>2));
  })).toBe(false);
  await page.screenshot({path:'artifacts/reading-corpus/large-text-line-word-cues.png'});
 }finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
});
