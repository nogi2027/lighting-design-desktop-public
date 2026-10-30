"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { NOTE_EXIT_DELAY_MS } from "../lib/rail-motion";

const ENTER_EVENT = "rail-hover-enter";

// Keep outgoing cards open briefly, including when the next card is entered.
// Each card owns its timer, so an old close cannot clear the new hover target.
export function useRailHover(onChange: (id: string | null) => void, kind: "cue" | "note" | "compact-note" = "note") {
  const delay = kind === "note" ? NOTE_EXIT_DELAY_MS : 0;
  const delayRef = useRef(delay);
  const owner = useId();
  const target = useRef<string | null>(null);
  const timers = useRef(new Map<string, number>());
  const active = useRef(new Set<string>());
  const [activeIds, setActiveIds] = useState<ReadonlySet<string>>(new Set());
  const cancel = useCallback((id?: string) => {
    if (id !== undefined) {
      const timer = timers.current.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.current.delete(id);
    } else {
      timers.current.forEach(timer => window.clearTimeout(timer));
      timers.current.clear();
    }
  }, []);
  const clear = useCallback(() => {
    cancel();
    const changed = target.current !== null || active.current.size > 0;
    target.current = null;
    active.current.clear();
    if (changed) { setActiveIds(new Set()); onChange(null); }
  }, [cancel, onChange]);
  const close = useCallback((id: string) => {
    timers.current.delete(id);
    if (active.current.delete(id)) setActiveIds(new Set(active.current));
    if (target.current === id) { target.current = null; onChange(null); }
  }, [onChange]);
  useLayoutEffect(() => {
    delayRef.current = delay;
    if (delay === 0) [...timers.current.keys()].forEach(id => { cancel(id); close(id); });
  }, [delay, cancel, close]);
  const leave = useCallback((id: string) => {
    if (!active.current.has(id) || timers.current.has(id)) return;
    if (delayRef.current === 0) { close(id); return; }
    timers.current.set(id, window.setTimeout(() => close(id), delayRef.current));
  }, [close]);
  const enter = useCallback((id: string) => {
    cancel(id);
    const same = target.current === id;
    if (target.current && !same) leave(target.current);
    target.current = id;
    if (!active.current.has(id)) { active.current.add(id); setActiveIds(new Set(active.current)); }
    if (!same) onChange(id);
    if (!same) window.dispatchEvent(new CustomEvent(ENTER_EVENT, { detail: owner }));
  }, [cancel, leave, onChange, owner]);
  useEffect(() => {
    const handoff = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== owner && target.current !== null) leave(target.current);
    };
    window.addEventListener(ENTER_EVENT, handoff);
    return () => { clear(); window.removeEventListener(ENTER_EVENT, handoff); };
  }, [clear, leave, owner]);
  return { enter, leave, clear, activeIds };
}
