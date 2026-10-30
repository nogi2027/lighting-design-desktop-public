"use client";

import { useEffect, useState, type RefObject } from "react";

export function ScriptReadingProgress({ frameRef }: { frameRef: RefObject<HTMLDivElement | null> }) {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let tick = 0;
    const update = () => {
      const range = frame.scrollHeight - frame.clientHeight;
      setProgress(range > 0 ? Math.round(Math.max(0, Math.min(1, frame.scrollTop / range)) * 1000) / 10 : 0);
    };
    const schedule = () => { cancelAnimationFrame(tick); tick = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    resize.observe(frame);
    const observeContent = () => { [...frame.children].forEach(child => resize.observe(child)); schedule(); };
    const content = new MutationObserver(observeContent);
    content.observe(frame, { childList:true });
    observeContent();
    frame.addEventListener("scroll", schedule, { passive:true });
    return () => { cancelAnimationFrame(tick); resize.disconnect(); content.disconnect(); frame.removeEventListener("scroll", schedule); };
  }, [frameRef]);
  return <div className="script-reading-progress" role="progressbar" aria-label="Script reading progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><span style={{ transform:`scaleX(${progress / 100})` }} /></div>;
}
