import { useEffect, useRef, useState } from 'react';

export function ShowMenu({status,onProblem}:{status:'saved'|'waiting'|'problem';onProblem:()=>void}) {
 const root=useRef<HTMLDetailsElement>(null);
 const [filename,setFilename]=useState('No show file saved yet');
 useEffect(()=>{
  const close=(event:Event)=>{if(root.current && !root.current.contains(event.target as Node))root.current.open=false;};
  const key=(event:KeyboardEvent)=>{
   if(!root.current?.open)return;
   if(event.key==='Escape'){root.current.open=false;root.current.querySelector('summary')?.focus();}
   if(['ArrowDown','ArrowUp','Home','End'].includes(event.key) && root.current.contains(event.target as Node)){
    event.preventDefault();const items=[...root.current.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
    const index=items.indexOf(document.activeElement as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowUp'?-1:1)+items.length)%items.length;
    items[next]?.focus();
   }
  };
  document.addEventListener('pointerdown',close);document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',key);};
 },[]);
 const action=(name:string)=>{root.current!.open=false;window.dispatchEvent(new CustomEvent('desktop-show-command',{detail:name}));};
 return <details ref={root} className="desktop-show-menu" onToggle={()=>{if(root.current?.open)void window.desktop.session().then(session=>setFilename(session?.path?.split(/[\\/]/).at(-1)||'No show file saved yet'));}}>
  <summary role="button" aria-label="SHOW" aria-haspopup="menu">SHOW <span aria-hidden="true">⌄</span></summary>
  <div role="menu" aria-label="Show files">
   <small>{filename}</small>
   {[['save','Save show'],['save-as','Save show as…'],['open','Open show…'],['new','New show…']].map(([name,label])=><button role="menuitem" key={name} onClick={()=>action(name)}>{label}</button>)}
   {status==='problem'?<button role="menuitem" className="show-save-problem" onClick={()=>{root.current!.open=false;onProblem();}}>Local save needs attention</button>:<small role="status">{status==='waiting'?'Saving local changes…':'Local changes saved'}</small>}
  </div>
 </details>;
}
