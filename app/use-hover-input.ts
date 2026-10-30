"use client";
import { useSyncExternalStore } from "react";

export function isHoverPointer(event: Pick<PointerEvent,"pointerType"|"buttons">) {
  return event.pointerType === "mouse" || event.pointerType === "pen" && event.buttons === 0;
}
let capable=false;
let activePointer:string|null=null;
const listeners=new Set<()=>void>();
let stop:(()=>void)|undefined;
const publish=(next:boolean)=>{if(next===capable)return;capable=next;listeners.forEach(listener=>listener());};
function subscribe(listener:()=>void) {
  listeners.add(listener);
  if (!stop) {
    const media=window.matchMedia("(any-hover: hover) and (any-pointer: fine)");
    const update=()=>publish(activePointer==="pen" || activePointer==="mouse" || activePointer!=="touch" && media.matches);
    const pointer=(event:PointerEvent)=>{
      // Pencil hover is reported by Pointer Events even when touch remains
      // the primary pointer. Never depend on an iPad identifying as desktop.
      if(event.pointerType==="touch" || isHoverPointer(event)){activePointer=event.pointerType;update();}
    };
    media.addEventListener("change",update);
    window.addEventListener("pointerover",pointer,{capture:true,passive:true});
    window.addEventListener("pointermove",pointer,{capture:true,passive:true});
    window.addEventListener("pointerdown",pointer,{capture:true,passive:true});
    update();
    stop=()=>{media.removeEventListener("change",update);for(const type of ["pointerover","pointermove","pointerdown"] as const)window.removeEventListener(type,pointer,true);stop=undefined;};
  }
  return ()=>{listeners.delete(listener);if(!listeners.size)stop?.();};
}
export function useHoverInput(){return useSyncExternalStore(subscribe,()=>capable,()=>false);}
