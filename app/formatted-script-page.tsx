"use client";
import { isHoverPointer } from "./use-hover-input";

import { useEffect, useMemo, useRef } from "react";
import { discussionTargetType } from "../lib/discussion-ui";
import { cueMarkerLabel } from "../lib/cue-marker";
import { renderScriptPage, resolveCueSource, sourceAnchor, type ReadingOptions } from "../lib/formatted-script";
import type { Cue, Discussion } from "../lib/types";
import { noteIconMarkup } from "./script-icons";

const voiceChoices = new Map<string, number>();
let fontReadiness: Promise<FontFaceSet> | undefined;

export type ReaderGeometry = { height: number; width: number; cues: Record<string, { x: number; y: number }>; sourceYs: { source: number; y: number }[] };

export function readingTarget(root: HTMLElement, anchorY: number) {
  return [...root.querySelectorAll<HTMLElement>(".reader-word")].reduce<{ element: HTMLElement; distance: number } | null>((best, element) => {
    const distance = Math.abs(Number(element.dataset.sourceY) - anchorY);
    return !best || distance < best.distance ? { element, distance } : best;
  }, null)?.element;
}

export function readingDraftAtPoint(reading: ReadingOptions, root: HTMLElement, x: number, y: number, selected = false) {
  const range = selected && window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
  const words = [...root.querySelectorAll<HTMLElement>(".reader-word")];
  const chosen = range && !range.collapsed ? words.filter(word => range.intersectsNode(word)) : [];
  const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>(".reader-word");
  const first = chosen[0] ?? (hit && root.contains(hit) ? hit : words.reduce<{ word: HTMLElement; distance: number } | null>((best, word) => {
    const rect = word.getBoundingClientRect();
    if (!rect.height) return best;
    const distance = Math.abs(rect.top + rect.height / 2 - y) * 10 + Math.abs(rect.left - x);
    return !best || distance < best.distance ? { word, distance } : best;
  }, null)?.word);
  if (!first) return null;
  const last = chosen.filter(word => word.dataset.sourceLine === first.dataset.sourceLine).at(-1) ?? first;
  const draft = sourceAnchor(reading.document, first.dataset.sourceLine!, Number(first.dataset.sourceWord), Number(last.dataset.sourceWord));
  // A reflowed phrase can span several original PDF lines. Preserve its full
  // text while anchoring to the first source word, excluding injected markers.
  if (draft && chosen.length) draft.selectedText = chosen.map(word => word.textContent).join(" ").replace(/\s+/g, " ").trim();
  return draft;
}

function panToVoice(run: HTMLElement, index: number) {
  const panel = run.querySelector<HTMLElement>(".reader-voice-panels")!;
  run.dataset.requestedVoice = String(index);
  panel.scrollLeft = run.querySelector<HTMLElement>(`[data-voice-index="${index}"]`)!.offsetLeft;
  requestAnimationFrame(() => { delete run.dataset.requestedVoice; });
}

export function revealReadingTarget(target: HTMLElement | null | undefined) {
  const column = target?.closest<HTMLElement>(".reader-voice-column"), run = column?.closest<HTMLElement>(".reader-parallel-run");
  const panel = run?.querySelector<HTMLElement>(".reader-voice-panels");
  if (run?.classList.contains("mobile-voices") && panel && column) {
    panToVoice(run, Number(column.dataset.voiceIndex));
    run.dataset.activeVoice = column.dataset.voiceIndex;
    voiceChoices.set(run.dataset.voiceKey!, Number(column.dataset.voiceIndex));
  }
}

export function FormattedScriptPage({ reading, pageNumber, cues, selectedCueId, hoveredCueId, onHoverCue, onSelectCue, onGeometry, notes, compact, onOpenNotes, onOpenCueNotes }: {
  reading: ReadingOptions; pageNumber: number; cues: Cue[]; notes: Discussion[]; compact: boolean; onOpenNotes: (ids: string[]) => void; onOpenCueNotes: (id: string) => void; selectedCueId: string | null; hoveredCueId: string | null;
  onHoverCue: (id: string | null) => void; onSelectCue: (id: string) => void; onGeometry: (geometry: ReaderGeometry) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSelectCue, onHoverCue, onGeometry, onOpenNotes, onOpenCueNotes });
  useEffect(() => { callbacks.current = { onSelectCue, onHoverCue, onGeometry, onOpenNotes, onOpenCueNotes }; }, [onSelectCue, onHoverCue, onGeometry, onOpenNotes, onOpenCueNotes]);
  const html = useMemo(() => renderScriptPage(reading.document, pageNumber), [reading.document, pageNumber]);
  const markup = useMemo(() => ({ __html: html }), [html]);
  const markerSnapshot = JSON.stringify(cues.map(cue => ({ id:cue.id, number:cue.number, title:cue.title, page:cue.page, anchorType:cue.anchorType, selectedText:cue.selectedText, enclosingLine:cue.enclosingLine, anchorX:cue.anchorX, anchorY:cue.anchorY, mode:cue.mode, blackout:cue.blackout })));
  const anchors = useMemo(() => (JSON.parse(markerSnapshot) as Cue[]).map(cue => ({ cue, source:resolveCueSource(reading.document, cue) })), [markerSnapshot, reading.document]);

  const noteSnapshot = JSON.stringify(notes.map(note => ({ id:note.id, targetType:note.targetType, cueId:note.cueId, sceneId:note.sceneId, page:note.page, anchorX:note.anchorX, anchorY:note.anchorY, selectedText:note.selectedText, enclosingLine:note.enclosingLine })));
  const noteAnchors = useMemo(() => JSON.parse(noteSnapshot) as Discussion[], [noteSnapshot]);
  // Activity retains this DOM while Script is hidden. Reconnecting listeners
  // must not rebuild its markers or measure all 16,578 words again.
  const retainedLayout = useRef<{
    anchors: typeof anchors; notes: typeof noteAnchors; compact: boolean; html: string;
    standaloneNotes: Map<HTMLElement, HTMLElement>; key: string; width: number; fontsReady: boolean;
  } | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const previous = retainedLayout.current;
    const reuse = previous?.anchors === anchors && previous.notes === noteAnchors && previous.compact === compact && previous.html === html;
    const standaloneNotes = reuse ? previous.standaloneNotes : new Map<HTMLElement, HTMLElement>();
    if (!reuse) {
      callbacks.current.onHoverCue(null);
      // Keep source text stable during collaborative text edits. Only marker DOM
      // changes; a remote title edit must not clear the reader's selection.
      root.querySelectorAll(".reader-note-marker,.reader-cue-note-marker").forEach(marker => marker.remove());
      // Note visibility and responsive mode changes only rebuild note icons.
      // Keep cue hit targets attached while resizing across the gutter boundary.
      if (previous?.anchors !== anchors || previous.html !== html) {
        root.querySelectorAll(".reader-cue-marker").forEach(marker => marker.remove());
        root.querySelectorAll<HTMLElement>(".reader-cue-word-wrap").forEach(wrap => { wrap.replaceWith(...wrap.childNodes); });
      }
      for (const { cue, source } of anchors) {
        if (!source) continue;
        const word = root.querySelector<HTMLElement>(`[data-source-line="${source.lineId}"][data-source-word="${source.word}"]`);
        if (!word) continue;
        let wrap = word.parentElement!;
        if (!wrap.classList.contains("reader-cue-word-wrap")) {
          wrap = document.createElement("span"); wrap.className = "reader-cue-word-wrap";
          word.replaceWith(wrap); wrap.append(word);
        }
        let marker = wrap.querySelector<HTMLButtonElement>(`.reader-cue-marker[data-cue-id="${CSS.escape(cue.id)}"]`);
        if (!marker) {
        marker = document.createElement("button");
        marker.type = "button";
        marker.dataset.cueId = cue.id;
        marker.className = `reader-cue-marker script-anchor-hit ${cue.anchorType === "line" ? "line-anchor" : "word-anchor phrase-anchor"} ${cue.mode} ${cue.blackout ? "blackout" : ""}`;
        marker.setAttribute("aria-label", `Select ${cue.number ? `LX ${cue.number}` : "Unassigned cue"}: ${cue.title}`);
        marker.setAttribute("aria-pressed", "false");
        const shape = document.createElement("span");
        shape.className = `reader-marker-shape ${cue.anchorType !== "line" && cueMarkerLabel(cue.number).length > 2 ? "overflow-pill" : ""}`; shape.textContent = cueMarkerLabel(cue.number);
        const shapeWidth = Math.max(cue.anchorType === "line" ? 24 : 18, shape.textContent.length * 7.2 + 8);
        shape.style.width = `${shapeWidth}px`;
        marker.style.setProperty("--reader-shape-width", `${shapeWidth}px`);
        marker.style.width = `${Math.max(44, Math.ceil(shapeWidth * 1.28 + 6))}px`;
        marker.append(shape); wrap.append(marker);
        }
        delete marker.dataset.noteWidth;
        const attached = compact ? noteAnchors.filter(note => discussionTargetType(note) === "cue" && note.cueId === cue.id) : [];
        if (attached.length) {
          const note = document.createElement("button"); note.type = "button";
          note.className = "reader-cue-note-marker reader-note-icon"; note.dataset.cueId = cue.id;
          const noteSize = cue.anchorType === "line" ? 24 : 18;
          note.style.setProperty("--cue-note-size", `${noteSize}px`);
          note.style.setProperty("--cue-note-origin", cue.anchorType === "line" ? "right center" : "center bottom");
          note.setAttribute("aria-label", `${attached.length} note threads for LX ${cue.number ?? "unassigned"}: ${cue.title}`);
          note.setAttribute("aria-pressed", "false");
          note.innerHTML = noteIconMarkup;
          if (attached.length > 1) { const count = document.createElement("b"); count.textContent = String(attached.length); note.append(count); }
          wrap.append(note); marker.dataset.noteWidth = String(noteSize + (attached.length > 1 ? 9 : 3));
        }
        if (cue.anchorType === "line" && !marker.querySelector(".reader-line-stem")) { const stem = document.createElement("span"); stem.className = "reader-line-stem"; stem.setAttribute("aria-hidden", "true"); marker.append(stem); }
      }
      if (compact) {
        const groups = new Map<HTMLElement, string[]>();
        for (const note of noteAnchors.filter(note => discussionTargetType(note) === "script")) {
          const source = resolveCueSource(reading.document, { page:pageNumber, anchorType:"phrase", selectedText:note.selectedText ?? "", enclosingLine:note.enclosingLine ?? "", anchorX:note.anchorX, anchorY:note.anchorY });
          const word = source ? root.querySelector<HTMLElement>(`[data-source-line="${source.lineId}"][data-source-word="${source.word}"]`) : readingTarget(root, note.anchorY ?? .12);
          if (word) groups.set(word, [...(groups.get(word) ?? []), note.id]);
        }
        groups.forEach((ids, word) => {
          const note = document.createElement("button"); note.type = "button"; note.className = "reader-note-marker reader-note-icon";
          note.dataset.noteIds = ids.join(","); note.setAttribute("aria-label", `Open ${ids.length} script ${ids.length === 1 ? "note" : "notes"}`); note.innerHTML = noteIconMarkup;
          if (ids.length > 1) { const count = document.createElement("b"); count.textContent = String(ids.length); note.append(count); }
          root.append(note); standaloneNotes.set(note, word);
        });
      }
    }
    const layoutKey = `${reading.font}:${reading.size}:${reading.leading}:${reading.pages}`;
    const retained = retainedLayout.current = {
      anchors, notes: noteAnchors, compact, html, standaloneNotes,
      key: reuse ? previous.key : "", width: reuse ? previous.width : -1, fontsReady: reuse && previous.fontsReady,
    };
    let frame = 0, destroyed = false, measuredWidth = retained.width;
    const selectPart = (run: HTMLElement, index: number, propagate = false) => {
      const changed = Number(run.dataset.activeVoice || 0) !== index;
      run.dataset.activeVoice = String(index);
      voiceChoices.set(run.dataset.voiceKey!, index);
      if (changed && propagate) root.ownerDocument.querySelectorAll<HTMLElement>(`.reader-parallel-run[data-voice-key="${run.dataset.voiceKey}"]`).forEach(other => {
        if (other === run || Number(other.dataset.activeVoice || 0) === index) return;
        other.dataset.activeVoice = String(index);
        if (other.classList.contains("mobile-voices")) panToVoice(other, index);
      });
    };
    const layout = () => {
      if (destroyed) return;
      measuredWidth = root.clientWidth;
      const narrow = root.clientWidth <= 680;
      root.querySelectorAll<HTMLElement>(".reader-parallel-run").forEach(run => {
        const panel = run.querySelector<HTMLElement>(".reader-voice-panels")!;
        const changed = run.classList.contains("mobile-voices") !== narrow || Number(run.dataset.panelWidth) !== panel.clientWidth;
        run.classList.toggle("mobile-voices", narrow);
        run.dataset.panelWidth = String(panel.clientWidth);
        const count = Number(run.dataset.voices);
        run.style.setProperty("--voice-max-width", `${narrow ? Math.max(144, panel.clientWidth - 28) : (panel.clientWidth - (count - 1) * 14) / count}px`);
        const choice = voiceChoices.get(run.dataset.voiceKey!) ?? Number(run.dataset.activeVoice || 0);
        if (changed && narrow) panToVoice(run, choice);
        selectPart(run, choice);
      });
      const words = [...root.querySelectorAll<HTMLElement>(".reader-word")];
      root.querySelectorAll<HTMLElement>(".reader-cue-word-wrap").forEach(wrap => { wrap.style.paddingTop = "0px"; });
      // Pack visible badges, not their enlarged hover/touch targets. Each
      // physical text line reserves just the rows it needs, retaining anchors.
      type Item = { marker: HTMLElement; word: HTMLElement; wrap: HTMLElement; row: number; x: number; width: number; line: boolean; raised: boolean };
      const groups: { host: HTMLElement; y: number; items: Item[] }[] = [];
      root.querySelectorAll<HTMLElement>(".reader-cue-marker").forEach(marker => {
        const wrap = marker.parentElement!, word = wrap.querySelector<HTMLElement>(".reader-word")!;
        const host = word.closest<HTMLElement>(".reader-turn-body,.reader-direction,.reader-song,.reader-act")!;
        const glyph = word.getBoundingClientRect();
        let group = groups.find(group => group.host === host && Math.abs(group.y - glyph.top) < 2);
        if (!group) { group = { host, y:glyph.top, items:[] }; groups.push(group); }
        const shape = marker.querySelector<HTMLElement>(".reader-marker-shape");
        group.items.push({ marker, word, wrap, row:0, x:glyph.left, width:(shape?.offsetWidth ?? marker.offsetWidth) + Number(marker.dataset.noteWidth ?? 0), line:marker.classList.contains("line-anchor"), raised:false });
      });
      groups.sort((a,b) => a.y - b.y);
      for (const group of groups) {
        const wordItems = group.items.filter(item => !item.line).sort((a,b) => a.x - b.x);
        const rowEnds: number[] = [];
        for (const item of wordItems) {
          let row = 0;
          while (rowEnds[row] != null && rowEnds[row] + 4 > item.x) row++;
          item.row = row; rowEnds[row] = item.x + item.width;
        }
        const wordRows = rowEnds.length;
        const lineItems = group.items.filter(item => item.line);
        const reference = group.items[0].word.getBoundingClientRect();
        const textRects = words.filter(word => group.host.contains(word)).map(word => word.getBoundingClientRect()).filter(rect => Math.abs(rect.top - reference.top) < 2);
        const lineLeft = Math.min(...textRects.map(rect => rect.left));
        const paper = root.closest<HTMLElement>(".pdf-page-stage")!.getBoundingClientRect();
        const viewport = root.closest<HTMLElement>(".pdf-frame")!.getBoundingClientRect();
        const column = group.host.closest<HTMLElement>(".reader-voice-column");
        // Gutter readers can use the gap beside the paper. In a swiping voice,
        // stay inside that column and its clipping viewport instead.
        const marginLeft = column ? column.getBoundingClientRect().left + 4 : Math.max(viewport.left + 4, paper.left + (compact ? 4 : -16));
        let marginX = lineLeft - 6, lineRow = 0, lineX = lineLeft;
        const raisedItems: Item[] = [];
        for (const item of lineItems) {
          if (marginX - item.width >= marginLeft) {
            item.x = marginX - item.width; marginX = item.x - 6;
            continue;
          }
          item.raised = true; raisedItems.push(item);
          if (lineX > lineLeft && lineX + item.width > group.host.getBoundingClientRect().right) { lineRow++; lineX = lineLeft; }
          item.row = lineRow; item.x = lineX; lineX += item.width + 6;
        }
        const lineRows = raisedItems.length ? lineRow + 1 : 0;
        const reserved = wordRows * 22 + lineRows * 32;
        const aboveItems = [...wordItems, ...raisedItems];
        const left = Math.min(...aboveItems.map(item => item.x)), right = Math.max(...aboveItems.map(item => item.x + item.width));
        const previousBottom = reserved ? words.filter(word => !group.items.some(item => item.wrap.contains(word))).map(word => word.getBoundingClientRect()).filter(rect => rect.height && rect.top < reference.top - 2 && rect.right > left - 4 && rect.left < right + 4).reduce((max,rect) => Math.max(max,rect.bottom), root.getBoundingClientRect().top) : 0;
        const needed = reserved ? Math.max(0, Math.ceil(previousBottom + (lineRows ? 8 : 2) + reserved - reference.top)) : 0;
        // One inline wrapper changes this line's ascent, without inserting
        // source text or shifting any word horizontally.
        group.items[0].wrap.style.paddingTop = `${needed}px`;
        group.items.forEach(item => { item.marker.dataset.markerRow = String(item.row); item.marker.classList.toggle("raised-line-cue", item.raised); item.marker.classList.toggle("packed-marker", group.items.length > 1); });
      }
      for (const group of groups) {
        const wordRows = Math.max(-1,...group.items.filter(item => !item.line).map(item => item.row)) + 1;
        const reference = group.items[0].word.getBoundingClientRect();
        const textRects = words.filter(word => group.host.contains(word)).map(word => word.getBoundingClientRect()).filter(rect => Math.abs(rect.top - reference.top) < 2);
        const lineLeft = Math.min(...textRects.map(rect => rect.left));
        for (const item of group.items) {
          const glyph = item.word.getBoundingClientRect(), origin = item.wrap.getBoundingClientRect();
          const shape = item.marker.querySelector<HTMLElement>(".reader-marker-shape");
          const shapeWidth = shape?.offsetWidth ?? item.marker.offsetWidth, shapeHeight = shape?.offsetHeight ?? 20;
          const x = item.line ? item.x : glyph.left;
          const top = item.line ? item.raised ? glyph.top - wordRows * 22 - 32 * (item.row + 1) : glyph.top + (glyph.height - shapeHeight) / 2 : glyph.top - 22 * item.row - shapeHeight - 2;
          item.marker.style.left = `${x - origin.left - (item.marker.offsetWidth - shapeWidth) / 2}px`;
          item.marker.style.top = `${top - origin.top - (item.marker.offsetHeight - shapeHeight) / 2}px`;
          item.marker.style.visibility = "visible";
          const note = item.wrap.querySelector<HTMLElement>(`.reader-cue-note-marker[data-cue-id="${item.marker.dataset.cueId}"]`);
          if (note) {
            note.style.left = `${x + shapeWidth + 3 - origin.left}px`;
            note.style.top = `${top - origin.top + (shapeHeight - note.offsetHeight) / 2}px`;
            note.style.setProperty("--cue-note-origin", item.line && !item.raised ? "right center" : "center bottom");
            const rightOrigin = item.line && !item.raised;
            // Keep a 7 px gap between enlarged badges, including their rings.
            const growth = (rightOrigin ? 0 : shapeWidth * .14) + note.offsetWidth * (rightOrigin ? .28 : .14);
            note.style.setProperty("--cue-note-hover-gap", `${growth + 4}px`);
          }
          let stem = item.marker.querySelector<HTMLElement>(".reader-line-stem,.reader-word-stem");
          if (item.line && !item.raised) {
            if (!stem) { stem = document.createElement("span"); stem.className = "reader-line-stem"; stem.setAttribute("aria-hidden", "true"); item.marker.append(stem); }
            stem.style.left = `${(item.marker.offsetWidth + shapeWidth) / 2}px`;
            stem.style.top = `${item.marker.offsetHeight / 2 - .5}px`;
            stem.style.width = `${Math.max(0,lineLeft - x - shapeWidth)}px`;
            stem.style.height = "1px";
          } else if (!item.line && item.row > 0) {
            if (!stem) { stem = document.createElement("span"); stem.className = "reader-word-stem"; stem.setAttribute("aria-hidden", "true"); item.marker.append(stem); }
            stem.style.left = `${(item.marker.offsetWidth - shapeWidth) / 2 + 1}px`;
            stem.style.top = `${(item.marker.offsetHeight + shapeHeight) / 2 - 1}px`;
            stem.style.width = "1px";
            stem.style.height = `${Math.max(4,glyph.top - top - shapeHeight + 4)}px`;
          } else stem?.remove();
        }
      }
      root.querySelectorAll<HTMLElement>(".reader-parallel-run").forEach(run => {
        const panel = run.querySelector<HTMLElement>(".reader-voice-panels")!;
        panel.style.height = run.classList.contains("mobile-voices") ? `${Math.max(...[...run.querySelectorAll<HTMLElement>(":scope>.reader-voice-panels>.reader-swiping-columns>.reader-voice-column")].map(column => column.offsetHeight))}px` : "";
        selectPart(run, Number(run.dataset.activeVoice || 0));
      });
      positionStandaloneNotes();
      const bounds = root.parentElement!.getBoundingClientRect();
      const geometry: ReaderGeometry = { height: Math.ceil(root.parentElement!.offsetHeight), width: bounds.width, cues: {}, sourceYs: [] };
      root.querySelectorAll<HTMLElement>(".reader-cue-marker").forEach(marker => {
        const rect = marker.getBoundingClientRect(); geometry.cues[marker.dataset.cueId!] = { x: rect.left - bounds.left + rect.width / 2, y: rect.top - bounds.top + rect.height / 2 };
      });
      root.querySelectorAll<HTMLElement>(".reader-source-line").forEach(line => {
        const word = line.querySelector<HTMLElement>(".reader-word");
        if (word) geometry.sourceYs.push({ source: Number(word.dataset.sourceY), y: word.getBoundingClientRect().top - bounds.top });
      });
      retained.width = measuredWidth;
      retained.key = layoutKey;
      callbacks.current.onGeometry(geometry);
    };
    const positionStandaloneNotes = () => {
      const origin = root.getBoundingClientRect();
      let previousBottom = -Infinity;
      [...standaloneNotes].sort((a,b) => a[1].getBoundingClientRect().top - b[1].getBoundingClientRect().top).forEach(([note, word]) => {
        const glyph = word.getBoundingClientRect(), panel = word.closest<HTMLElement>(".reader-voice-panels")?.getBoundingClientRect();
        const visible = !panel || glyph.right > panel.left && glyph.left < panel.right;
        note.hidden = !visible;
        if (!visible) return;
        const top = Math.max(glyph.top + (glyph.height - note.offsetHeight) / 2, previousBottom + 2);
        note.style.left = `${origin.width + 8}px`; note.style.top = `${top - origin.top}px`;
        previousBottom = top + note.offsetHeight;
      });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(layout); };
    const click = (event: Event) => {
      const target = event.target as HTMLElement;
      const note = target.closest<HTMLElement>(".reader-note-marker,.reader-cue-note-marker");
      if (note) { event.stopPropagation(); if (note.dataset.cueId) callbacks.current.onOpenCueNotes(note.dataset.cueId); else callbacks.current.onOpenNotes(note.dataset.noteIds!.split(",")); return; }
      const cue = target.closest<HTMLElement>(".reader-cue-marker");
      if (cue) {
        event.stopPropagation();
        const attached = cue.parentElement?.querySelector(`.reader-cue-note-marker[data-cue-id="${cue.dataset.cueId}"]`);
        if (attached) callbacks.current.onOpenCueNotes(cue.dataset.cueId!);
        else callbacks.current.onSelectCue(cue.dataset.cueId!);
      }
    };
    const hover = (event: Event) => {
      if(event instanceof PointerEvent && event.type === "pointerover" && !isHoverPointer(event))return;
      const cue = (event.target as HTMLElement).closest<HTMLElement>(".reader-cue-marker,.reader-cue-note-marker");
      if (!cue) return;
      const related = (event as MouseEvent | FocusEvent).relatedTarget;
      if (related instanceof Node && cue.contains(related)) return;
      const relatedCue = related instanceof Element ? related.closest<HTMLElement>(".reader-cue-marker,.reader-cue-note-marker") : null;
      if (relatedCue?.dataset.cueId === cue.dataset.cueId) return;
      callbacks.current.onHoverCue(event.type === "pointerover" || event.type === "focusin" ? cue.dataset.cueId! : null);
    };
    const key = (event: KeyboardEvent) => {
      const panel = (event.target as HTMLElement).closest<HTMLElement>(".reader-voice-panels"), run = panel?.parentElement;
      if (!panel || !run || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const last = Number(run.dataset.voices) - 1;
      const index = event.key === "Home" ? 0 : event.key === "End" ? last : Math.max(0, Math.min(last, Number(run.dataset.activeVoice || 0) + (event.key === "ArrowRight" ? 1 : -1)));
      panToVoice(run, index);
      selectPart(run, index, true);
      positionStandaloneNotes();
    };
    const scroll = (event: Event) => {
      const panel = event.target as HTMLElement, run = panel.parentElement!;
      const columns = [...run.querySelectorAll<HTMLElement>(".reader-voice-column")];
      // Content-sized voices have different widths. The last part can be fully
      // visible before its start reaches the left edge; avoid trailing filler.
      const atEnd = panel.scrollLeft > 0 && panel.scrollLeft >= panel.scrollWidth - panel.clientWidth - 2;
      const index = run.dataset.requestedVoice != null ? Number(run.dataset.requestedVoice) : atEnd ? columns.length - 1 : columns.reduce((best, column, index) => Math.abs(column.offsetLeft - panel.scrollLeft) < Math.abs(columns[best].offsetLeft - panel.scrollLeft) ? index : best, 0);
      selectPart(run, index, true);
      positionStandaloneNotes();
    };
    root.addEventListener("click", click); root.addEventListener("keydown", key);
    ["pointerover", "pointerout", "focusin", "focusout"].forEach(type => root.addEventListener(type, hover));
    root.querySelectorAll(".reader-voice-panels").forEach(panel => panel.addEventListener("scroll", scroll));
    // Marker clearance changes our own height. Only a
    // width change requires another reflow; other inputs explicitly schedule it.
    const frameElement = root.closest<HTMLElement>(".pdf-frame");
    const hasVoices = !!root.querySelector(".reader-parallel-run");
    const nearby = () => {
      if (!frameElement) return true;
      const paper = (root.closest<HTMLElement>(".pdf-page-slot") ?? root).getBoundingClientRect(), viewport = frameElement.getBoundingClientRect();
      return paper.bottom >= viewport.top - 600 && paper.top <= viewport.bottom + 600;
    };
    const observer = new ResizeObserver(entries => { if (entries[0].contentRect.width > 0 && Math.abs(entries[0].contentRect.width - measuredWidth) > .5 && (hasVoices || nearby())) schedule(); }); observer.observe(root);
    // Keep distant marker geometry until that page approaches the viewport.
    // Voice layouts still update immediately so jumps can reveal any part.
    const visibility = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && Math.abs(root.clientWidth - measuredWidth) > .5) schedule(); }, { root:frameElement, rootMargin:"600px 0px" });
    visibility.observe(root);
    if (retained.key !== layoutKey) schedule();
    // Read font readiness once; accessing it separately for every page can
    // flush the preceding page's style writes.
    if (!fontReadiness) fontReadiness = document.fonts.ready;
    void fontReadiness.then(() => {
      if (!destroyed && !retained.fontsReady) { retained.fontsReady = true; schedule(); }
    });
    return () => { destroyed = true; cancelAnimationFrame(frame); observer.disconnect(); visibility.disconnect(); root.removeEventListener("click", click); root.removeEventListener("keydown", key); ["pointerover", "pointerout", "focusin", "focusout"].forEach(type => root.removeEventListener(type, hover)); root.querySelectorAll(".reader-voice-panels").forEach(panel => panel.removeEventListener("scroll", scroll)); };
  }, [anchors, noteAnchors, compact, html, pageNumber, reading.document, reading.size, reading.leading, reading.font, reading.pages]);

  useEffect(() => {
    rootRef.current?.querySelectorAll<HTMLElement>(".reader-cue-marker,.reader-cue-note-marker").forEach(marker => {
      marker.setAttribute("aria-pressed", String(marker.dataset.cueId === selectedCueId));
      marker.classList.toggle("hover-linked", marker.dataset.cueId === hoveredCueId);
    });
  }, [anchors, noteAnchors, compact, html, selectedCueId, hoveredCueId, reading.size, reading.leading, reading.font, reading.pages]);

  return <div ref={rootRef} className={`reader-flow font-${reading.font}`} style={{ fontSize: reading.size, lineHeight: reading.leading }} dangerouslySetInnerHTML={markup} />;
}
