"use client";

import { useLayoutEffect, type RefObject } from "react";
import { CARD_CLOSE_MS, GAP_CLOSE_SPEED, LONG_OPEN_SPEED, sampleRailCurve, type RailCurve } from "../lib/rail-motion";

const slots = ".rail-cue-slot,.rail-note-slot";
type CardMotion = { height:number; target:number; lower:number; upper:number; compact:boolean; openDuration:number; curve?:RailCurve };

// Own spacing on one frame clock. CSS transition shortening and repeated WAAPI
// retiming can otherwise disagree about the start height during fast reversals.
export function useRailCollapseSpeed(rootRef: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const cards = new Map<HTMLElement, CardMotion>();
    const elements = new Set(root.querySelectorAll<HTMLElement>(slots));
    let frame = 0;

    const targetFor = (element:HTMLElement) => {
      const cue = element.classList.contains("rail-cue-slot");
      const row = cue ? element.querySelector<HTMLElement>(".aligned-cue-row") : null;
      const lower = cue ? 30 : element.classList.contains("has-replies") ? 42 : 28;
      const upper = cue ? 54 : (parseFloat(element.style.getPropertyValue("--discussion-height")) || 54) + 6;
      const expanded = cue ? Boolean(row?.matches(":hover,:focus-visible,.hover-linked") || element.querySelector(".cue-rail-actions:hover,.cue-rail-actions:focus-within")) : element.classList.contains("expanded");
      const compact = cue || element.dataset.compact === "true";
      const longCue = Boolean(row && ((row.querySelector(".aligned-cue-intention")?.textContent?.length ?? 0) > 60 || (row.querySelector(".aligned-cue-top b")?.textContent?.length ?? 0) > 60));
      const openDuration = cue ? longCue ? 320 : 200 : compact ? 150 : Math.max(220, (upper - lower) / LONG_OPEN_SPEED * 1000);
      return { target:expanded ? upper : lower, lower, upper, compact, openDuration };
    };
    const settle = (element:HTMLElement) => {
      delete element.dataset.motion;
      element.dispatchEvent(new Event("rail-layout-settled", { bubbles:true }));
    };
    const advance = (now:number) => {
      const finished:HTMLElement[] = [];
      for (const [element, card] of cards) {
        if (!element.isConnected) { cards.delete(element); continue; }
        if (!card.curve) continue;
        const sampled = sampleRailCurve(card.curve, now);
        card.height = sampled.height;
        element.style.height = `${card.height}px`;
        if (sampled.finished) { card.curve = undefined; finished.push(element); }
      }
      // Write the entire frame before notifying packing observers. They must
      // never measure a mix of this frame's heights and the previous frame's.
      finished.forEach(element=>delete element.dataset.motion);
      finished.forEach(settle);
    };
    const tick = () => {
      frame = 0;
      // RAF's timestamp is the start of the frame. A hover reconciliation may
      // already have sampled later in that same frame, after React/layout work.
      // Use one clock at the point of writing so motion never rewinds then jumps.
      advance(performance.now());
      if ([...cards.values()].some(card => card.curve)) frame = window.requestAnimationFrame(tick);
    };
    const start = (element:HTMLElement, card:CardMotion, now:number, duration:number, velocity:number) => {
      card.curve = { from:card.height, to:card.target, velocity, duration:Math.max(1,duration), started:now };
      element.dataset.motion = "changing";
    };
    const reconcile = () => {
      if (reduced.matches) return;
      const now = performance.now();
      for (const [element] of cards) {
        if (element.closest('.continuous-page-row[data-layout-mode="laptop"]')) continue;
        element.style.removeProperty("height");element.style.removeProperty("--card-open-duration");
        cards.delete(element);settle(element);
      }
      // Sample the same trajectory before changing targets; never read a new
      // CSS transition's before-change value as our current animated height.
      advance(now);
      const changed: {element:HTMLElement;card:CardMotion;velocity:number}[] = [];
      // Read all targets before writing styles. Interleaving these operations
      // used to flush style across the whole script once per card.
      const targets = [...elements].filter(element => element.closest('.continuous-page-row[data-layout-mode="laptop"]')).map(element => ({ element, next:targetFor(element) }));
      for (const { element, next } of targets) {
        const duration = `${next.openDuration}ms`;
        if (element.style.getPropertyValue("--card-open-duration") !== duration) element.style.setProperty("--card-open-duration", duration);
        let card = cards.get(element);
        if (!card) {
          card = { ...next, height:next.target };
          cards.set(element, card);
          element.style.height = `${card.height}px`;
          continue;
        }
        if (card.target === next.target && card.compact === next.compact) { Object.assign(card,next); continue; }
        const velocity = card.curve ? sampleRailCurve(card.curve,now).velocity : 0;
        Object.assign(card, next);
        changed.push({ element, card, velocity });
      }
      // All compact cards in a handoff share a finish time. Their combined
      // height and velocity stay continuous, including multiple fast reversals.
      const compactChanged = changed.some(item => item.card.compact);
      if (compactChanged) {
        const moving = [...cards].filter(([,card]) => card.compact && (card.curve || card.height !== card.target));
        const incoming = moving.filter(([,card]) => card.target > card.height);
        const distance = incoming.length === 1 ? incoming[0][1].target - incoming[0][1].height : Math.max(0,...moving.map(([,card])=>Math.abs(card.target-card.height)));
        const duration = Math.max(120, distance / GAP_CLOSE_SPEED * 1000, ...incoming.map(([,card])=>card.openDuration));
        const velocities = moving.map(([element,card]) => changed.find(item=>item.element===element)?.velocity ?? (card.curve ? sampleRailCurve(card.curve,now).velocity : 0));
        let scale = 1;
        moving.forEach(([,card],index) => {
          const velocity = velocities[index];
          const room = velocity > 0 ? card.upper - card.height : card.height - card.lower;
          if (velocity) scale = Math.min(scale, 3 * Math.max(0,room) / (Math.abs(velocity)*duration));
        });
        moving.forEach(([element,card],index) => start(element,card,now,duration,velocities[index]*scale));
      }
      for (const {element,card,velocity} of changed) {
        if (card.compact) continue;
        const opening = card.target > card.height;
        const duration = opening ? card.openDuration : Math.max(CARD_CLOSE_MS,Math.abs(card.target-card.height) / GAP_CLOSE_SPEED*1000);
        const room = velocity > 0 ? card.upper-card.height : card.height-card.lower;
        const bounded = Math.sign(velocity)*Math.min(Math.abs(velocity),3*Math.max(0,room)/duration);
        start(element,card,now,duration,bounded);
      }
      if (!frame && [...cards.values()].some(card=>card.curve)) frame = window.requestAnimationFrame(tick);
    };
    const observer = new MutationObserver(records => {
      let membershipChanged = false;
      for (const record of records) {
        if (record.type !== "childList") continue;
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (!(node instanceof HTMLElement)) continue;
          const found = node.matches(slots) ? [node] : [...node.querySelectorAll<HTMLElement>(slots)];
          for (const element of found) {
            if (root.contains(element)) {
              if (!elements.has(element)) { elements.add(element); membershipChanged = true; }
            } else { membershipChanged = elements.delete(element) || membershipChanged; cards.delete(element); }
          }
        }
      }
      const changed = membershipChanged || records.some(record => {
        if (record.attributeName === "data-layout-mode") return true;
        if (record.type === "childList") return false;
        const element = record.target instanceof HTMLElement ? record.target.closest<HTMLElement>(slots) : null;
        if (!element) return false;
        const card = cards.get(element),next = targetFor(element);
        return !card || card.target !== next.target || card.compact !== next.compact || card.upper !== next.upper;
      });
      if (changed) reconcile();
    });
    const reset = () => {
      window.cancelAnimationFrame(frame);frame=0;
      for (const [element] of cards) { element.style.removeProperty("height"); settle(element); }
      cards.clear();
      if (!reduced.matches) reconcile();
    };
    reconcile();
    observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:["class","style","data-compact","data-layout-mode"]});
    root.addEventListener("rail-hover-motion-change",reconcile);
    reduced.addEventListener("change",reset);
    return () => {
      observer.disconnect();window.cancelAnimationFrame(frame);
      root.removeEventListener("rail-hover-motion-change",reconcile);reduced.removeEventListener("change",reset);
      for (const [element] of cards) { element.style.removeProperty("height");element.style.removeProperty("--card-open-duration");delete element.dataset.motion; }
    };
  }, [enabled,rootRef]);
}
