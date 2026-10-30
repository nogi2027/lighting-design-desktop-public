"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { CUE_MOTION_MS } from "./use-cue-presence";

/** Resize once, then animate the reading-area shift without repeated text reflow. */
export function ScriptWorkspace({ detailOpen, frameRef, children }: { detailOpen: boolean; frameRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const previousWidth = useRef(0);
  const previousOpen = useRef(detailOpen);
  const movement = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const changed = previousOpen.current !== detailOpen;
    previousOpen.current = detailOpen;
    // Returning to Script reconnects this effect, but retains its geometry.
    if (!changed && previousWidth.current) return;
    const width = frame.clientWidth;
    const before = previousWidth.current || width;
    previousWidth.current = width;
    const flow = frame.querySelector<HTMLElement>(".script-page-flow");
    if (!flow || window.innerWidth < 900 || window.matchMedia("(prefers-reduced-motion: reduce)").matches || before === width) { movement.current?.cancel(); return; }
    const offset = new DOMMatrix(getComputedStyle(flow).transform).m41;
    movement.current?.cancel();
    flow.style.willChange = "transform";
    const animation = flow.animate([{ transform:`translateX(${(before - width) / 2 + offset}px)` }, { transform:"translateX(0)" }], { duration:CUE_MOTION_MS, easing:"cubic-bezier(.2,.7,.2,1)" });
    movement.current = animation;
    void animation.finished.then(() => { if (movement.current === animation) { flow.style.willChange = ""; movement.current = null; } }, () => {});
  }, [detailOpen, frameRef]);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => { previousWidth.current = frame.clientWidth; });
    observer.observe(frame);
    return () => { observer.disconnect(); movement.current?.cancel(); };
  }, [frameRef]);
  return <div className={`script-layout ${detailOpen ? "detail-open" : ""}`}>{children}</div>;
}
