/* eslint-disable @typescript-eslint/no-require-imports */
const { app, dialog, ipcMain, protocol } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');
const backend = require('./backend.cjs');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'dist');
const storage = () => path.join(app.getPath('userData'), 'shows');
const examples = () => !app.isPackaged && process.env.LX_DESKTOP_CORPUS ? path.resolve(process.env.LX_DESKTOP_CORPUS) : app.isPackaged ? path.join(process.resourcesPath, 'examples') : path.join(root, 'examples');
const actor = { id: 'local', name: 'Local', role: 'Offline', initials: 'LX', color: '#35a7ff' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const limit = 256 * 1024 * 1024;
let current, pending, window, queue = Promise.resolve();
const serial = work => { const next = queue.catch(() => {}).then(work); queue = next; return next; };
async function atomic(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
function normalize(state) {
  const localNote = note => ({ ...note, authorId: actor.id, resolvedBy: note.resolved ? actor.id : undefined, replies: (note.replies ?? []).map(reply => ({ ...reply, authorId: actor.id })) });
  return { ...state, schemaVersion: 12, profiles: [actor], scenes: state.scenes.map(scene => ({ ...scene, startY: Math.round(scene.startY * 1e6) / 1e6, ownerId: null })), cues: state.cues.map(cue => ({ ...cue, ownerId: undefined })), discussions: state.discussions.map(localNote), history: (state.history ?? []).map(event => ({ ...event, actorId: actor.id, targetProfileIds: undefined })), inboxReads: [], inboxPins: [], conflicts: [], deletedCues: state.deletedCues.map(item => ({ ...item, deletedBy: actor.id, cue: { ...item.cue, ownerId: undefined }, discussions: item.discussions.map(localNote) })) };
}
function portable(state) {
  const { profiles, inboxReads, inboxPins, conflicts, ...rest } = state;
  void profiles; void inboxReads; void inboxPins; void conflicts;
  return { ...rest, schemaVersion: 1 };
}
async function bounded(file, maximum) {
  if ((await fs.stat(file)).size > maximum) throw new Error('The recovery file is too large.');
  return fs.readFile(file);
}
async function legacy(id) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid show ID.');
  const directory = path.join(app.getPath('userData'),'recovery',id);
  const state = JSON.parse(await bounded(path.join(directory,'state.json'),12*1024*1024));
  if (state.id !== id) throw new Error('The recovery ID does not match.');
  return { identity:{id,title:state.title,document:state.document}, state, dirty:true, legacy:true, updatedAt:(await fs.stat(path.join(directory,'state.json'))).mtime.toISOString() };
}
async function metadata() {
  const dirs = await fs.readdir(storage(), { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const entry of dirs) if (entry.isDirectory()) {
    try { result.push(JSON.parse(await fs.readFile(path.join(storage(), entry.name, 'show.json'), 'utf8'))); } catch { /* Incomplete imports do not replace a saved show. */ }
  }
  for (const entry of await fs.readdir(path.join(app.getPath('userData'),'recovery'),{withFileTypes:true}).catch(()=>[])) if (entry.isDirectory() && !result.some(item=>item.identity.id === entry.name)) {
    try { result.push(await legacy(entry.name)); } catch { /* Invalid older recovery copies stay untouched. */ }
  }
  return result.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
}
async function session() {
  if (!current) return null;
  const state = { ...await backend.projection(), ...current.identity, document: current.identity.document };
  return { state, path: current.path, dirty: current.dirty };
}
async function activate(meta, databaseBytes) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(meta.identity.id)) throw new Error('Invalid show ID.');
  const directory = path.join(storage(), meta.identity.id);
  await fs.mkdir(directory, { recursive: true });
  if (databaseBytes) await atomic(path.join(directory, 'workspace.sqlite'), databaseBytes);
  await backend.initialize(path.join(directory, 'workspace.sqlite'), normalize(meta.state), path.join(root, 'drizzle'));
  current = { identity: meta.identity, path: meta.path ?? null, dirty: meta.dirty ?? true, directory };
  await remember();
  return session();
}
async function remember() {
  if (!current) return;
  await atomic(path.join(current.directory, 'show.json'), JSON.stringify({ identity: current.identity, path: current.path, dirty: current.dirty, state: (await session()).state, updatedAt: new Date().toISOString() }));
  window?.setDocumentEdited(current.dirty);
  window?.setTitle(`${current.identity.title}${current.dirty ? ' •' : ''} — Lighting Design Desktop`);
}
async function save(as = false) {
  if (!current) return null;
  let file = as ? null : current.path;
  if (!file) {
    const selected = await dialog.showSaveDialog(window, { title: 'Save show', defaultPath: `${current.identity.title.replace(/[/\\:]/g, '-')}.lxshow`, filters: [{ name: 'Lighting show', extensions: ['lxshow'] }] });
    if (selected.canceled) return null;
    file = selected.filePath.toLowerCase().endsWith('.lxshow') ? selected.filePath : `${selected.filePath}.lxshow`;
  }
  return serial(async () => {
    const state = (await session()).state;
    const files = { 'show.json': strToU8(JSON.stringify(portable(state))), 'script.pdf': await fs.readFile(path.join(current.directory, 'script.pdf')), 'reading.json': await fs.readFile(path.join(current.directory, 'reading.json')), 'workspace.sqlite': await fs.readFile(path.join(current.directory, 'workspace.sqlite')) };
    if (Object.values(files).reduce((sum,b) => sum+b.length, 0) > limit) throw new Error('The show exceeds the 256 MB limit.');
    const manifest = { format: 'lighting-design-show', version: 2, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: hash(bytes) }])) };
    await atomic(file, zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(manifest)) }, { level: 1 }));
    current.path = file; current.dirty = false;
    await remember();
    return session();
  });
}
async function openShow(file) {
  if ((await fs.stat(file)).size > limit) throw new Error('The show exceeds the 256 MB limit.');
  const bytes = await fs.readFile(file);
  if (bytes.length > limit) throw new Error('The show exceeds the 256 MB limit.');
  const caps = { 'manifest.json': 8192, 'show.json': 12*1024*1024, 'script.pdf': 100*1024*1024, 'reading.json': 100*1024*1024, 'workspace.sqlite': 128*1024*1024 };
  let total = 0; const seen = new Set();
  const files = unzipSync(bytes, { filter(entry) {
    if (!Object.hasOwn(caps, entry.name) || seen.has(entry.name) || entry.originalSize > caps[entry.name] || (total += entry.originalSize) > limit) throw new Error('Invalid or oversized show entry.');
    seen.add(entry.name); return true;
  } });
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  if (manifest.format !== 'lighting-design-show' || ![1,2].includes(manifest.version) || seen.size !== (manifest.version === 1 ? 4 : 5)) throw new Error('Unsupported show format.');
  for (const [name, content] of Object.entries(files)) if (name !== 'manifest.json' && (manifest.files?.[name]?.bytes !== content.length || manifest.files?.[name]?.sha256 !== hash(content))) throw new Error('The show failed its integrity check.');
  const state = JSON.parse(strFromU8(files['show.json']));
  const reading = JSON.parse(strFromU8(files['reading.json']));
  const { validateShow, validateReading } = await import('../lib/show-validation.mjs');
  validateShow(state); validateReading(reading, state);
  if (hash(files['script.pdf']) !== state.document.version || Buffer.from(files['script.pdf'].subarray(0,5)).toString() !== '%PDF-') throw new Error('The script does not match this show.');
  const identity = { id: randomUUID(), title: state.title, document: { ...state.document, id: state.document.id } };
  const directory = path.join(storage(), identity.id);
  await fs.mkdir(directory, { recursive: true });
  await atomic(path.join(directory,'script.pdf'), files['script.pdf']);
  await atomic(path.join(directory,'reading.json'), files['reading.json']);
  const previous = current;
  try { return await activate({ identity, state: { ...state, ...identity }, path: file, dirty: false }, files['workspace.sqlite']); }
  catch (error) {
    if (previous) { const meta = JSON.parse(await fs.readFile(path.join(previous.directory,'show.json'),'utf8')); await activate(meta); }
    throw error;
  }
}
async function pickPdf(file) {
  if ((await fs.stat(file)).size > 100*1024*1024) throw new Error('PDFs must be smaller than 100 MB.');
  const bytes = await fs.readFile(file);
  if (bytes.subarray(0,5).toString() !== '%PDF-') throw new Error('Choose a valid PDF file.');
  pending = { filename: path.basename(file), bytes: new Uint8Array(bytes) };
  return pending;
}
async function setup() {
  protocol.handle('app', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'desktop') return new Response(null, { status: 403 });
      if (url.pathname.startsWith('/api/sync/')) return serial(async () => {
        if (!current) return Response.json({ error: 'Open a show first.' }, { status: 404 });
        if (request.method === 'POST') {
          const body = await request.clone().json();
          const batch = Array.isArray(body) ? body : body.operations;
          if (Array.isArray(batch) && batch.some(operation => operation.actorId !== actor.id || ['saveProfile','createOrUpdateProfile','upsertProfile','setSceneOwners','setInboxRead','setInboxPinned'].includes(operation.action?.type))) return Response.json({ error: 'Team operations are disabled in the offline app.' }, { status: 403 });
        }
        const response = await backend.route(request);
        if (request.method === 'POST' && response.ok) { current.dirty = true; await remember(); }
        return response;
      });
      if (url.pathname === '/desktop/bootstrap') return Response.json(await session());
      if (url.pathname === '/script-search-index.json' && current) {
        const reading = JSON.parse(await fs.readFile(path.join(current.directory,'reading.json'),'utf8'));
        return Response.json({ pages: reading.pages.map(page => ({ page: page.pdfPage, text: reading.lines.filter(line => line.pdfPage === page.pdfPage).map(line => line.text).join('\n') })) });
      }
      let target;
      if (current && ['/api/script','/lt-script.pdf','/show/script.pdf'].includes(url.pathname)) target = path.join(current.directory,'script.pdf');
      else if (current && ['/script/reading.json','/show/reading.json'].includes(url.pathname)) target = path.join(current.directory,'reading.json');
      else {
        target = path.resolve(assets, '.'+decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
        if (!target.startsWith(assets+path.sep)) return new Response(null, { status: 403 });
      }
      const types = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.pdf':'application/pdf', '.wasm':'application/wasm', '.woff2':'font/woff2', '.woff':'font/woff', '.svg':'image/svg+xml', '.png':'image/png' };
      return new Response(new Uint8Array(await fs.readFile(target)), { headers: { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control':'no-store' } });
    } catch(error) { console.error(error); return Response.json({ error: error.message }, { status: 500 }); }
  });
  const handle = (name, callback) => ipcMain.handle(`desktop:${name}`, (event,...args) => {
    if (!window || event.sender.id !== window.webContents.id || !event.senderFrame?.url.startsWith('app://desktop/')) throw new Error('Untrusted workspace request.');
    return callback(...args);
  });
  handle('session', () => serial(session));
  handle('open-pdf', async () => { const result = await dialog.showOpenDialog(window,{filters:[{name:'PDF script',extensions:['pdf']}],properties:['openFile']}); return result.canceled ? null : pickPdf(result.filePaths[0]); });
  handle('examples', async () => JSON.parse(await fs.readFile(path.join(examples(),'catalog.json'),'utf8')));
  handle('example', async id => { const catalog=JSON.parse(await fs.readFile(path.join(examples(),'catalog.json'),'utf8')); if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id) || !catalog.some(item=>item.id===id)) throw new Error('Unknown example.'); return pickPdf(path.join(examples(),`${id}.pdf`)); });
  handle('recent', metadata);
  handle('recovery', metadata);
  handle('recover', id => serial(async () => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid show ID.');
    let meta;
    try { meta=JSON.parse(await fs.readFile(path.join(storage(),id,'show.json'),'utf8')); }
    catch(error) { if(error.code !== 'ENOENT') throw error; meta=await legacy(id); }
    if(meta.legacy) {
      const source=path.join(app.getPath('userData'),'recovery',id);
      const pdf=await bounded(path.join(source,'script.pdf'),100*1024*1024);
      const reading=JSON.parse(await bounded(path.join(source,'reading.json'),100*1024*1024));
      const {validateShow,validateReading}=await import('../lib/show-validation.mjs');
      validateShow(meta.state);validateReading(reading,meta.state);
      if(hash(pdf) !== meta.state.document.version) throw new Error('The recovery PDF does not match.');
      await atomic(path.join(storage(),id,'script.pdf'),pdf);
      await atomic(path.join(storage(),id,'reading.json'),JSON.stringify(reading));
    }
    return activate(meta);
  }));
  handle('finish-import', (state,reading) => serial(async () => {
    if (!pending || hash(pending.bytes) !== state.document.version) throw new Error('Choose the script again.');
    const normalized = normalize(state);
    const projection = portable(normalized);
    const { validateShow, validateReading } = await import('../lib/show-validation.mjs');
    validateShow(projection); validateReading(reading,projection);
    const identity = { id: state.id, title: state.title, document: state.document };
    const directory = path.join(storage(),identity.id);
    await fs.mkdir(directory,{recursive:true});
    await atomic(path.join(directory,'script.pdf'),pending.bytes);
    await atomic(path.join(directory,'reading.json'),JSON.stringify(reading));
    pending = null;
    return activate({ identity, state: normalized, dirty:true });
  }));
  handle('open-show', async file => { if (!file) { const result = await dialog.showOpenDialog(window,{filters:[{name:'Lighting show',extensions:['lxshow']}],properties:['openFile']}); if(result.canceled) return null; file=result.filePaths[0]; } return serial(() => openShow(file)); });
  handle('save', save);
  handle('new', () => serial(async () => { await remember(); current=null; backend.close(); }));
}
function attach(value) { window=value; }
function command(value) { window?.webContents.send('desktop-command',value); }
module.exports = { setup, attach, command, save, actor };
