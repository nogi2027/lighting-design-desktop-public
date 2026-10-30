import { useEffect, useState, type ComponentType } from 'react';
import { Onboarding } from '../app/onboarding';
import { importScript, type ImportResult } from '../lib/import-script';
import { configureDefaultState } from '../lib/default-state';
import { configureScriptPages } from '../lib/script-page-number';
import type { DesktopState, ImportSource } from './show-model';
import { readPreference, writePreference } from '../lib/ui-preferences';
import type { FormattedDocument } from '../lib/formatted-script';

type Session = { state: DesktopState; path: string | null; dirty: boolean };
type Draft = { source: ImportSource; result: ImportResult };
export function DesktopApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [Workspace, setWorkspace] = useState<ComponentType | null>(null);
  const [examples, setExamples] = useState<Array<{ id: string; title: string; description: string; lab?: boolean }>>([]);
  const [recent, setRecent] = useState<Array<{ identity: { id: string; title: string }; updatedAt: string }>>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [controller, setController] = useState<AbortController | null>(null);
  async function load(next: Session | null) {
    if (next) {
      if(readPreference('lt-script-reading').value===null) writePreference('lt-script-reading',JSON.stringify({font:'source'}));
      configureDefaultState(next.state);
      configureScriptPages(next.state.document.firstPage);
      window.desktopShowId = next.state.id;
      const workspaceModule = await import('../app/lighting-dashboard');
      setWorkspace(() => workspaceModule.LightingDashboard);
    }
    setDraft(null); setSession(next);
    setRecent(await window.desktop.recent());
  }
  async function flush() {
    if (window.desktopFlush && !await window.desktopFlush()) throw new Error('Wait for the current edit to finish saving, then try again. Your recovery data is kept.');
  }
  async function run(work: () => Promise<unknown>) { setError(''); try { await work(); } catch (error) { setError(error instanceof Error ? error.message : 'Could not finish this action.'); } }
  async function start(example?: string, forceOcr = window.desktopForceOcr ?? false) {
    await flush();
    const source = example ? await window.desktop.example(example) : await window.desktop.openPdf();
    if (!source) return;
    const cancel = new AbortController(); setController(cancel); setProgress('Reading your PDF…');
    try {
      const result = await importScript(source.bytes, p => setProgress(`${p.phase}: page ${p.page} of ${p.total}`), cancel.signal, forceOcr);
      setDraft({ source, result });
    } catch (error) { if (!cancel.signal.aborted) throw error; }
    finally { setController(null); setProgress(''); }
  }
  async function command(name: string) {
    if (name === 'undo' || name === 'redo') {
      const target = document.activeElement;
      if (target?.matches('[data-sync-text-field]')) target.dispatchEvent(new KeyboardEvent('keydown', { key:'z', ctrlKey:true, shiftKey:name === 'redo', bubbles:true, cancelable:true }));
      else document.execCommand(name);
      return;
    }
    if (name === 'new') { await flush(); await window.desktop.newShow(); window.location.reload(); }
    if (name === 'import') await start();
    if (name === 'open') { await flush(); const next = await window.desktop.openShow(); if (next) window.location.reload(); }
    if (name === 'save' || name === 'save-as') { await flush(); await window.desktop.save(name === 'save-as'); }
  }
  useEffect(() => {
    void window.desktop.examples().then(async examples => { setExamples(examples); await load(await window.desktop.session()); }).catch(error => setError(error.message));
    const showCommand=(event:Event)=>{void run(()=>command((event as CustomEvent<string>).detail));};
    window.addEventListener('desktop-show-command',showCommand);
    const stop=window.desktop.onCommand(name => { void run(() => command(name)); });
    return ()=>{stop();window.removeEventListener('desktop-show-command',showCommand);};
  // Commands use the main process session, independent of React render state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function finish(state: DesktopState, reading: FormattedDocument) { await load(await window.desktop.finishImport(state, reading)); }
  if (draft) return <Onboarding source={draft.source} result={draft.result} onCancel={() => setDraft(null)} onFinish={finish} />;
  const lab = examples.some(example=>example.lab);
  return <>
    {lab && session && <nav className="reading-lab-toolbar"><strong>READING LAB</strong><button onClick={() => void run(() => command('new'))}>Choose test script</button></nav>}
    {error && <aside className="desktop-error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></aside>}
    {progress ? <main className="desktop-start"><h1>{progress}</h1><button onClick={() => controller?.abort()}>Cancel import</button></main>
      : session && Workspace ? <Workspace key={session.state.id} />
      : <main className="desktop-start"><header><span className="eyebrow">LIGHTING DESIGN DESKTOP</span><h1>Start with your script.</h1><p>Import a PDF, review its scenes, and use the familiar lighting workspace.</p></header><div className="desktop-start-actions"><button className="primary-button" onClick={() => void run(() => start())}>New show from PDF</button><button onClick={() => void run(() => command('open'))}>Open show</button></div><label><input type="checkbox" onChange={event => { window.desktopForceOcr = event.target.checked; }} /> Force OCR on every page</label><h2>{lab ? `Test scripts (${examples.length})` : 'Examples'}</h2><div className="desktop-examples">{examples.map(example => <button className="example-card" key={example.id} onClick={() => void run(() => start(example.id, window.desktopForceOcr))}><strong>{example.title}</strong><span>{example.description}</span></button>)}</div>{recent.length > 0 && <section><h2>Recent shows and recovery</h2>{recent.map(item => <button className="file-row" key={item.identity.id} onClick={() => void run(async () => { await flush(); await window.desktop.recover(item.identity.id); window.location.reload(); })}>{item.identity.title}<small>{new Date(item.updatedAt).toLocaleString()}</small></button>)}</section>}</main>}
  </>;
}
