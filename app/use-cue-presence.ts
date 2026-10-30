"use client";

import { useLayoutEffect, useState, useSyncExternalStore } from "react";

export const CUE_MOTION_MS = 180;

function subscribeMotion(change: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}

/** Keep closing surfaces mounted until their exit transition finishes. */
export function useCuePresence(visible: boolean) {
  const reduce = useSyncExternalStore(subscribeMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => false);
  const [previous, setPrevious] = useState(visible);
  const [phase, setPhase] = useState<"entering" | "entered" | "exiting" | "exited">(visible ? "entering" : "exited");
  if (previous !== visible) {
    setPrevious(visible);
    setPhase(visible ? "entering" : "exiting");
  }
  useLayoutEffect(() => {
    if (reduce) return;
    let frame = 0;
    let timer = 0;
    if (visible) {
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setPhase("entered")); });
    } else {
      timer = window.setTimeout(() => setPhase("exited"), CUE_MOTION_MS);
    }
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [visible, reduce]);
  return { phase: reduce ? visible ? "entered" : "exited" : phase, present: reduce ? visible : phase !== "exited" };
}
