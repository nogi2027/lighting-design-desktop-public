import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
let app:ElectronApplication, page:Page, userData:string;
const errors:string[]=[];
test.beforeEach(async()=>{
 userData=await fs.mkdtemp(path.join(os.tmpdir(),'lx-parity-'));
 app=await _electron.launch({args:process.env.LX_DESKTOP_EXECUTABLE?[]:['.'],executablePath:process.env.LX_DESKTOP_EXECUTABLE,env:{...process.env,LX_DESKTOP_USER_DATA:userData,LX_DESKTOP_TEST_HIDE_WINDOWS:'1'}});
 page=await app.firstWindow(); page.on('pageerror',e=>errors.push(e.message));
 expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible()))).toBe(true);
});
test.afterEach(async()=>{await app?.close();expect(errors.splice(0)).toEqual([])});
async function imported(index=0,scenes=28){
 await page.locator('.example-card').nth(index).click();
 await expect(page.getByRole('heading',{name:'Set up your script'})).toBeVisible({timeout:120_000});
 await expect(page.getByLabel('Scene title',{exact:true})).toHaveCount(scenes);
 await page.screenshot({path:`artifacts/parity-onboarding-${index}.png`});
 await page.getByRole('button',{name:'Create show',exact:true}).click();
 await expect(page.locator('.formatted-script')).toBeVisible();
 await expect(page.locator('.app-shell')).toHaveAttribute('data-connection-state','online');
}
async function saved(){await expect.poll(()=>page.evaluate(()=>window.desktopFlush?.()),{timeout:15000}).toBe(true)}
async function command(name:string){await app.evaluate(({BrowserWindow},name)=>{BrowserWindow.getAllWindows()[0].webContents.send('desktop-command',name)},name)}
async function state(){return page.evaluate(async()=>{const response=await fetch('/api/sync/bootstrap'); return (await response.json()).state})}

test('original reader, search, preferences, editor, undo, history, notes and portable files',async()=>{
 await imported();
 await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{get:()=>false,configurable:true});window.dispatchEvent(new Event('offline'))});
 await expect(page.locator('.app-shell')).toHaveAttribute('data-connection-state','online');
 await expect(page.getByRole('button',{name:/Active profile:/})).toBeHidden();
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await expect(page.getByRole('button',{name:'Profiles',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Backup',exact:true})).toHaveCount(0);
 await page.getByRole('radio',{name:'Light',exact:true}).click();
 await page.getByLabel('Script typeface').selectOption('sans');
 await page.getByLabel('Script font size').selectOption('22');
 await page.getByLabel('Script line spacing').selectOption('1.65');
 await page.getByRole('button',{name:'Close settings'}).click();
 await page.keyboard.press('Meta+k');
 await expect(page.getByRole('textbox',{name:'Search workspace',exact:true})).toBeFocused();
 await page.getByRole('textbox',{name:'Search workspace',exact:true}).fill('thunder');
 await expect(page.locator('.search-preview-groups')).toContainText(/thunder/i);
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'New cue',exact:true}).click();
 // Keep the existing anchor picker and cue panel, including its keyboard behavior.
 await page.locator('.reader-word').filter({hasText:/Thunder/}).first().click();
 await page.getByRole('button',{name:'Word cue',exact:true}).click();
 await expect(page.getByLabel('Editable cue title')).toBeVisible();
 await saved();
 await page.getByLabel('Editable cue title').fill('Warm special');
 await expect.poll(async()=>(await state()).cues[0]?.title).toBe('Warm special');
 await page.getByLabel('Lighting intention').fill('Warm sidelight at the opening');
 await page.getByLabel('Technical and programming notes').fill('Fade 2 seconds');
 await saved();await page.getByLabel('Editable cue title').focus();await page.waitForTimeout(650);
 await page.keyboard.press('End'); await page.keyboard.type(' extra');
 await saved();
 await command('undo');
 await expect(page.getByLabel('Editable cue title')).not.toHaveValue('Warm special extra');
 await command('redo');
 await expect(page.getByLabel('Editable cue title')).toHaveValue('Warm special extra');
 await saved();
 if(await page.getByRole('button',{name:'Assign next number',exact:true}).isVisible())await page.getByRole('button',{name:'Assign next number',exact:true}).click();
 await page.getByLabel('Editable cue number').fill('12.125');await page.getByLabel('Editable cue number').press('Enter');await page.getByLabel('Editable cue title').focus();await saved();
 await page.getByRole('button',{name:'Mark Implemented',exact:true}).click();await saved();await expect(page.getByRole('button',{name:'Mark Implemented',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.locator('.blackout-toggle').click();await saved();
 const current=await state();expect(current.cues).toHaveLength(1);expect(current.cues[0]).toMatchObject({number:'LX 12.125',mode:'implemented',blackout:true,technicalNotes:'Fade 2 seconds'});
 await page.getByRole('button',{name:'View saved versions',exact:true}).click();
 await expect(page.locator('.text-history-versions article')).not.toHaveCount(0);
 await page.screenshot({path:'artifacts/parity-editor.png'});
 const beforeHistory=await page.locator('.text-history-versions article').count();
 const file=path.join(userData,'portable.lxshow');
 await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},file);
 await page.getByRole('button',{name:'SHOW',exact:true}).click();await page.getByRole('menuitem',{name:'Save show',exact:true}).click();await expect.poll(async()=>fs.stat(file).then(s=>s.size).catch(()=>0)).toBeGreaterThan(10000);
 await page.evaluate(async file=>window.desktop.openShow(file),file);await page.reload();
 await expect(page.locator('.formatted-script')).toBeVisible();
 expect((await state()).cues[0]).toMatchObject(current.cues[0]);
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await expect(page.getByLabel('Script typeface')).toHaveValue('sans');
 await expect(page.getByLabel('Script font size')).toHaveValue('22');await page.getByRole('button',{name:'Close settings'}).click();
 await page.getByRole('button',{name:'▦ Cues',exact:true}).click();
 await page.locator('.cue-list-page').getByRole('button',{name:/Open LX 12.125/}).click();
 await page.getByRole('button',{name:'View saved versions',exact:true}).click();
 await expect(page.locator('.text-history-versions article')).toHaveCount(beforeHistory);
 await page.getByRole('button',{name:'Delete this cue',exact:true}).click();
 await page.getByRole('button',{name:'Move to Recently deleted',exact:true}).click();await saved();
 expect((await state()).cues).toHaveLength(0);expect((await state()).deletedCues).toHaveLength(1);
 await page.locator('.undo-toast').getByRole('button',{name:'Undo',exact:true}).click();await saved();expect((await state()).cues).toHaveLength(1);
});
for(const [index,scenes] of [[1,3],[2,2]])test(`bundled PDF ${index} imports offline with scene review`,async()=>{
 const external:string[]=[]; page.on('request',r=>{if(/^https?:/.test(r.url()))external.push(r.url())});
 await imported(index,scenes);
 const current=await state();expect(current.scenes).toHaveLength(scenes);
 if(index===2){const reading=await page.evaluate(async()=>await fetch('/script/reading.json').then(r=>r.json()));expect(reading.pages.every((p:{ocr?:boolean})=>p.ocr)).toBe(true);expect(reading.lines.map((l:{text:string})=>l.text).join(' ')).toMatch(/Macbeth|thunder|Witch/i)}
 expect(external).toEqual([]);
});

test('native window preferences and unsaved-show recovery survive restart',async()=>{
 await imported(1,3);
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setBounds({width:1100,height:760});w.webContents.setZoomFactor(1.1)});
 const session=await page.evaluate(()=>window.desktop.session());
 await app.close();
 const preferences=JSON.parse(await fs.readFile(path.join(userData,'desktop-state.json'),'utf8'));expect(preferences.zoom).toBe(1.1);expect(preferences.window.width).toBe(1100);
 app=await _electron.launch({args:process.env.LX_DESKTOP_EXECUTABLE?[]:['.'],executablePath:process.env.LX_DESKTOP_EXECUTABLE,env:{...process.env,LX_DESKTOP_USER_DATA:userData,LX_DESKTOP_TEST_HIDE_WINDOWS:'1'}});
 page=await app.firstWindow();
 await page.locator('.file-row').first().click();await expect(page.locator('.formatted-script')).toBeVisible();
 expect((await page.evaluate(()=>window.desktop.session()))?.state.id).toBe(session?.state.id);
 expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(1.1);
});

test('version-1 shows, recovery copies and corrupted archives preserve the current show',async()=>{
 await imported(1,3);
 const file=path.join(userData,'test.lxshow');
 await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},file);
 await saved();await page.getByRole('button',{name:'SHOW',exact:true}).click();await page.getByRole('menuitem',{name:'Save show',exact:true}).click();await expect.poll(async()=>fs.stat(file).then(s=>s.size).catch(()=>0)).toBeGreaterThan(10000);
 const {zipSync,unzipSync,strToU8,strFromU8}=await import('fflate');
 const entries=unzipSync(await fs.readFile(file));
 const current=(await page.evaluate(()=>window.desktop.session()))!;
 const bad=path.join(userData,'corrupted.lxshow');await fs.writeFile(bad,zipSync({...entries,'show.json':strToU8('{}')}));
 const message=await page.evaluate(async file=>{try{await window.desktop.openShow(file);return ''}catch(e){return (e as Error).message}},bad);
 expect(message).toMatch(/integrity/);expect((await page.evaluate(()=>window.desktop.session()))?.state.id).toBe(current.state.id);
 const manifest=JSON.parse(strFromU8(entries['manifest.json']));manifest.version=1;delete manifest.files['workspace.sqlite'];delete entries['workspace.sqlite'];entries['manifest.json']=strToU8(JSON.stringify(manifest));
 const oldFile=path.join(userData,'version-1.lxshow');await fs.writeFile(oldFile,zipSync(entries));
 await page.evaluate(file=>window.desktop.openShow(file),oldFile);await page.reload();await expect(page.locator('.formatted-script')).toBeVisible();
 const oldState=JSON.parse(strFromU8(entries['show.json']));oldState.id='legacy-recovery';
 const recovery=path.join(userData,'recovery',oldState.id);await fs.mkdir(recovery,{recursive:true});
 await fs.writeFile(path.join(recovery,'state.json'),JSON.stringify(oldState));await fs.writeFile(path.join(recovery,'script.pdf'),entries['script.pdf']);await fs.writeFile(path.join(recovery,'reading.json'),entries['reading.json']);
 await page.evaluate(()=>window.desktop.recover('legacy-recovery'));await page.reload();await expect(page.locator('.formatted-script')).toBeVisible();
 expect((await page.evaluate(()=>window.desktop.session()))?.state.id).toBe('legacy-recovery');expect((await fs.stat(path.join(recovery,'state.json'))).isFile()).toBe(true);
 expect(await page.evaluate(async()=>{const r=await fetch('/api/sync/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operations:[{actorId:'local',action:{type:'createOrUpdateProfile'}}]})});return r.status})).toBe(403);
});
