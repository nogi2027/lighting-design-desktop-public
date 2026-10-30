"use client";

import { useHoverInput, isHoverPointer } from "./use-hover-input";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ComponentProps } from "react";
import { createPortal, flushSync } from "react-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { normalizeAnchorLine, snapSelectionToWords } from "../lib/anchor-text";
import { cueMarkerLabel as markerLabel, cueMarkerPosition, cueMarkerScaleForZoom } from "../lib/cue-marker";
import { formatCueNumber, orderCuePlacements } from "../lib/cue-numbering";
import { discussionPage, discussionTargetType } from "../lib/discussion-ui";
import { FIELD_LIMITS } from "../lib/field-limits";
import { getPdfZoomGeometry } from "../lib/pdf-zoom";
import { buildSceneGroups, createSceneLocator } from "../lib/scene-boundaries";
import { FIRST_SCRIPT_PDF_PAGE, scriptPageNumber } from "../lib/script-page-number";
import { layoutRailItems, makeRoomBelowPinnedItem } from "../lib/rail-layout";
import type { Cue, Discussion, Profile, Scene } from "../lib/types";
import { acquireScriptDocument } from "../lib/script-document";
import { loadFormattedDocument, resolveCueSource, type FormattedDocument, type ReadingOptions } from "../lib/formatted-script";
import { FormattedScriptPage, readingDraftAtPoint, readingTarget, revealReadingTarget, type ReaderGeometry } from "./formatted-script-page";
import type { ScriptReadingPreferences } from "../lib/ui-preferences";
import { DiscussionCard } from "./discussion-card";
import { ScriptNoteSheet } from "./script-note-sheet";
import { ArrowIcon, MoreIcon, NoteIcon } from "./script-icons";
import { useRailHover } from "./use-rail-hover";
import { useRailCollapseSpeed } from "./use-rail-collapse-speed";

export type PdfAnchorDraft = {
  page: number;
  selectedText: string;
  enclosingLine: string;
  anchorX: number;
  anchorY: number;
  /** The line position used when a phrase was selected. */
  lineAnchorY?: number;
  lineAnchorX?: number;
};

export type PendingNote =
  | { kind: "cue"; cueId: string; anchor: PdfAnchorDraft }
  | { kind: "script"; anchor: PdfAnchorDraft };

export type NoteVisibility = "none" | "active" | "all";

type TextRun = { text: string; x: number; y: number; width: number; height: number };
type PdfJs = typeof import("pdfjs-dist");
type SelectionDraft = PdfAnchorDraft & { lineAnchorX: number; lineAnchorY: number; left: number; top: number };
type SceneRailContext = { id: string; firstSceneId: string; number: string; name: string; owner: string; ownerInitials: string; unimplemented: number; total: number; openNotes: number; pageStart: number; startY: number };

const PDF_WIDTH = 360;
const PDF_HEIGHT = 576;
const EMPTY_CUES: Cue[] = [];
const EMPTY_DISCUSSIONS: Discussion[] = [];
const EMPTY_SCENE_BOUNDARIES: SceneRailContext[] = [];

// Event handlers retain their identity for memoized pages while delegating to
// the latest committed workspace state and write gates.
function useStableEvents<T extends Record<string, (...args: never[]) => unknown>>(callbacks: T): T {
  const latest = useRef(callbacks);
  useLayoutEffect(() => { latest.current = callbacks; }, [callbacks]);
  // This initializer creates event callbacks without invoking them. The ref is
  // read only when a later event calls one of those callbacks.
  // eslint-disable-next-line react-hooks/refs
  const [events] = useState(() => Object.fromEntries(Object.keys(callbacks).map(name => [
    name, (...args: never[]) => latest.current[name](...args),
  ])) as T);
  return events;
}

function nearReadingPage(root: HTMLElement) {
  const slot = root.closest<HTMLElement>(".pdf-page-slot");
  const frame = root.closest<HTMLElement>(".pdf-frame");
  if (!slot || !frame) return true;
  const page = slot.getBoundingClientRect(), viewport = frame.getBoundingClientRect();
  return page.bottom >= viewport.top - 1200 && page.top <= viewport.bottom + 1200;
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9]+/g, " ").trim();
}

function cueLabel(cue: Pick<Cue, "number">) {
  return formatCueNumber(cue.number);
}

function cueCardNumber(cue: Pick<Cue, "number">) {
  return formatCueNumber(cue.number, "TBD");
}

function cueCardAriaLabel(cue: Pick<Cue, "number" | "title">) {
  return cue.number ? `${formatCueNumber(cue.number)}: ${cue.title}` : `Unassigned cue: ${cue.title}`;
}

function profileInitials(profile?: Pick<Profile, "initials" | "name">) {
  return profile?.initials?.trim() || profile?.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "—";
}

function SceneRailCard({ scene, onClick, boundary = false, compact = false }: { scene: SceneRailContext; onClick: () => void; boundary?: boolean; compact?: boolean }) {
  if (compact) return <button type="button" className="reader-scene-card" data-scene-id={scene.firstSceneId} onClick={onClick} aria-label={`Open Scenes ${scene.number}, ${scene.name}, in Scenes`}><span className="reader-scene-title">{scene.number} · {scene.name}</span><span className="reader-scene-meta"><span className="reader-scene-owner" title={scene.owner}>{scene.owner}</span><span className="reader-scene-counts">{scene.total ? `${scene.total - scene.unimplemented}/${scene.total} completed` : "No cues yet"} · {scene.openNotes} open {scene.openNotes === 1 ? "note" : "notes"}</span></span></button>;
  return <button type="button" data-scene-id={scene.firstSceneId} className={`${boundary ? "scene-boundary-card " : ""}aligned-scene-card`} onClick={onClick} aria-label={`Open Scenes ${scene.number} in Scenes`}>
    <i className="scene-owner-initials" aria-label={`Assigned to ${scene.owner}`}>{scene.ownerInitials}</i>
    <span>SCENES {scene.number}</span>
    <strong>{scene.name}</strong>
    <small>OWNER · {scene.owner}</small>
    <em className={scene.total > 0 && scene.unimplemented === 0 ? "complete" : ""}>{scene.total ? `${scene.unimplemented}/${scene.total} unimplemented` : "No cues yet"}</em>
  </button>;
}

function lineAlignedAnchor(draft: PdfAnchorDraft): PdfAnchorDraft {
  return { ...draft, anchorY: draft.lineAnchorY ?? draft.anchorY };
}

function cueConnectorStyle(anchorType: Cue["anchorType"], number: number | null, x: number, y: number, displayY: number, railGap: number, markerScale: number, measured?: CSSProperties): CSSProperties {
  if (measured) return measured;
  const marker = cueMarkerPosition(anchorType, number, x, y, markerScale);
  const startX = -railGap;
  const startY = displayY + 14;
  const deltaX = railGap + marker.centerX;
  const deltaY = marker.centerY - startY;
  return { left: startX, top: startY, width: Math.hypot(deltaX, deltaY), transform: `rotate(${Math.atan2(deltaY, deltaX) * 180 / Math.PI}deg)` };
}

function isWordCharacter(value: string | undefined) {
  return !!value && /[\p{L}\p{N}'’‘]/u.test(value);
}

function wordRangeAtPoint(x: number, y: number, container: HTMLElement) {
  let node: Node | null = null;
  let offset = 0;
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) {
    node = position.offsetNode;
    offset = position.offset;
  } else {
    const legacyDocument = document as Document & { caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null };
    const legacyRange = legacyDocument.caretRangeFromPoint?.(x, y);
    node = legacyRange?.startContainer ?? null;
    offset = legacyRange?.startOffset ?? 0;
  }
  if (!node || !container.contains(node)) return null;
  if (node.nodeType !== Node.TEXT_NODE) node = node.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent ?? "";
  if (!text) return null;

  let index = Math.min(Math.max(0, offset), text.length - 1);
  if (!isWordCharacter(text[index])) {
    let right = index;
    while (right < text.length && !isWordCharacter(text[right])) right += 1;
    let left = index - 1;
    while (left >= 0 && !isWordCharacter(text[left])) left -= 1;
    index = right < text.length ? right : left;
  }
  if (index < 0 || !isWordCharacter(text[index])) return null;
  let start = index;
  let end = index + 1;
  while (start > 0 && isWordCharacter(text[start - 1])) start -= 1;
  while (end < text.length && isWordCharacter(text[end])) end += 1;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

export function PdfScriptViewer({
  pageCount,
  scale,
  cues,
  scenes,
  profiles,
  discussions,
  discussionCounts,
  noteVisibility,
  selectedCueId,
  anchorMode,
  noteMode,
  pendingNote,
  commentText,
  setCommentText,
  onCancelPendingNote,
  onPostPendingNote,
  outOfOrderCueIds,
  jumpRequest,
  onVisiblePage,
  onVisibleScene,
  onSelectCue,
  onOpenCueNotes,
  onOpenScene,
  onAnchorChosen,
  onNoteTarget,
  onPlaceNote,
  onReplyNote,
  onOpenDiscussion,
  onDismissDiscussion,
  focusedDiscussionId,
  replyingToId,
  replyText,
  setReplyText,
  startReply,
  cancelReply,
  postReply,
  toggleResolved,
  onMoveCue,
  onDeleteCue,
  onToggleCueMode,
  onToggleCueBlackout,
  onEditCueNumber,
  onUnassignCueNumber,
  busyGroups,
  onZoomIn,
  onZoomOut,
  zoomLabel,
  readingPreferences,
}: {
  readingPreferences: ScriptReadingPreferences;
  pageCount: number;
  scale: number;
  cues: Cue[];
  scenes: Scene[];
  profiles: Profile[];
  discussions: Discussion[];
  discussionCounts: Readonly<Record<string, number>>;
  noteVisibility: NoteVisibility;
  selectedCueId: string | null;
  anchorMode: boolean;
  noteMode: boolean;
  pendingNote: PendingNote | null;
  commentText: string;
  setCommentText: (value: string) => void;
  onCancelPendingNote: () => void;
  onPostPendingNote: () => void;
  outOfOrderCueIds: ReadonlySet<string>;
  jumpRequest: { page: number; anchorY?: number; key: string; preservePosition?: boolean; preserveCueId?: string; preserveTop?: boolean } | null;
  onVisiblePage: (page: number) => void;
  onVisibleScene: (sceneId: string) => void;
  onSelectCue: (id: string) => void;
  onOpenCueNotes: (cueId: string) => void;
  onOpenScene: (sceneId: string) => void;
  onAnchorChosen: (draft: PdfAnchorDraft, anchorType: "line" | "phrase") => void;
  onNoteTarget: (target: { type: "cue" | "scene"; id: string }, draft?: PdfAnchorDraft) => void;
  onPlaceNote: (target: { type: "cue" | "scene"; id: string } | null, draft: PdfAnchorDraft) => void;
  onReplyNote: (discussionId: string) => void;
  onOpenDiscussion: (discussionId: string) => void;
  onDismissDiscussion: () => void;
  focusedDiscussionId: string | null;
  replyingToId: string | null;
  replyText: string;
  setReplyText: (value: string) => void;
  startReply: (id: string) => void;
  cancelReply: () => void;
  postReply: (id: string) => void;
  toggleResolved: (discussion: Discussion) => void;
  onMoveCue: (cueId: string) => void;
  onDeleteCue: (cueId: string) => void;
  onToggleCueMode: (cueId: string) => void;
  onToggleCueBlackout: (cueId: string) => void;
  onEditCueNumber: (cueId: string) => void;
  onUnassignCueNumber: (cueId: string) => void;
  busyGroups: ReadonlySet<string>;
  onZoomIn: () => void;
  onZoomOut: () => void;
  zoomLabel: string;
}) {
  const pageElements = useRef(new Map<number, HTMLDivElement>());
  const firstScriptPage = useMemo(() => scenes.reduce((first, scene) => Math.min(first, scene.pageStart), pageCount), [pageCount, scenes]);
  const sceneGroups = useMemo(() => buildSceneGroups(scenes, pageCount, 5), [pageCount, scenes]);
  const locateScene = useMemo(() => createSceneLocator(scenes), [scenes]);
  const sceneContexts = useMemo<SceneRailContext[]>(() => {
    const counts = new Map<string, { total: number; unimplemented: number }>();
    for (const cue of cues) {
      const scene = locateScene(cue.page, cue.anchorY ?? 0);
      if (!scene) continue;
      const count = counts.get(scene.id) ?? { total: 0, unimplemented: 0 };
      count.total++;
      if (cue.mode !== "implemented") count.unimplemented++;
      counts.set(scene.id, count);
    }
    return sceneGroups.map((group) => {
      const ownerIds = [...new Set(group.scenes.map((scene) => scene.ownerId))];
      const ownerId = ownerIds.length === 1 ? ownerIds[0] : null;
      const owner = profiles.find((profile) => profile.id === ownerId);
      return {
        id: group.id,
        firstSceneId: group.scenes[0].id,
        number: group.number,
        name: group.name,
        owner: ownerIds.length > 1 ? "Mixed ownership" : owner ? `${owner.name} · ${owner.role}` : "Unassigned",
        ownerInitials: ownerIds.length > 1 ? "MIX" : profileInitials(owner),
        unimplemented: group.scenes.reduce((sum, scene) => sum + (counts.get(scene.id)?.unimplemented ?? 0), 0),
        total: group.scenes.reduce((sum, scene) => sum + (counts.get(scene.id)?.total ?? 0), 0),
        openNotes: discussions.filter(note => {
          if (note.resolved) return false;
          const cue = note.cueId ? cues.find(cue => cue.id === note.cueId) : null;
          const sceneId = cue ? locateScene(cue.page, cue.anchorY ?? 0)?.id : note.sceneId ?? (note.page ? locateScene(note.page, note.anchorY ?? 0)?.id : null);
          return group.scenes.some(scene => scene.id === sceneId);
        }).length,
        pageStart: group.pageStart,
        startY: group.startY,
      };
    });
  }, [cues, discussions, locateScene, profiles, sceneGroups]);
  const sceneBoundariesByPage = useMemo(() => {
    const map = new Map<number, SceneRailContext[]>();
    for (const context of sceneContexts) {
      const boundaries = map.get(context.pageStart) ?? [];
      boundaries.push(context); map.set(context.pageStart, boundaries);
    }
    return map;
  }, [sceneContexts]);
  const [formattedDocument, setFormattedDocument] = useState<FormattedDocument | null>(null);
  const readingView = readingPreferences.view !== "pdf";
  const { pages:showPages, font:readingFont, size:readingSize, leading:readingLeading } = readingPreferences;
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pdfjs, setPdfjs] = useState<PdfJs | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [visiblePage, setVisiblePage] = useState(firstScriptPage);
  const visiblePageRef = useRef(firstScriptPage);
  const reportedPageRef = useRef<number | null>(null);
  const pendingJumpPageRef = useRef<number | null>(null);
  const settlingPageJumpRef = useRef(false);
  const jumpSettledTimerRef = useRef<number | null>(null);
  const completedCueJumpRef = useRef<string | null>(null);
  const completedPageJumpRef = useRef<string | null>(null);
  const cancelCueJumpRef = useRef<(() => void) | null>(null);
  const cancelPageJumpRef = useRef<(() => void) | null>(null);
  const [railPosition, setRailPosition] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [nextCueId, setNextCueId] = useState<string | null>(null);
  const [activeSceneGroupId, setActiveSceneGroupId] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 1280 : window.innerWidth);
  const [viewportHeight, setViewportHeight] = useState(() => typeof window === "undefined" ? 800 : window.innerHeight);
  const [frameWidth, setFrameWidth] = useState(() => typeof window === "undefined" ? 1280 : window.innerWidth);
  const [pointerFine, setPointerFine] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const readingPosition = useRef<{ line: string; word: string; top: number } | null>(null);
  const restoringReading = useRef(false);
  const readingPositionPinned = useRef(false);
  const selectedCueRef = useRef<Cue | null>(null);
  const selectedCue = useMemo(() => cues.find((cue) => cue.id === selectedCueId) ?? null, [cues, selectedCueId]);
  const selectedCuePage = selectedCue?.page;
  useEffect(() => { selectedCueRef.current = selectedCue; }, [selectedCue]);
  const orderedCues = useMemo(() => orderCuePlacements(cues), [cues]);
  const laptopLayout = pointerFine && viewportWidth >= 1280 && viewportWidth / Math.max(1, viewportHeight) >= 1.34;
  const formatted = readingView && formattedDocument !== null;
  const hasReadingGutter = viewportWidth >= 900 && frameWidth >= 800;
  const layoutMode = formatted ? hasReadingGutter ? "laptop" : "overlap" : laptopLayout ? "laptop" : "overlap";
  useRailCollapseSpeed(viewerRef, status === "ready");
  const railLaptop = formatted ? hasReadingGutter : laptopLayout;
  const reading = useMemo<ReadingOptions | undefined>(() => {
    if (!formatted || !formattedDocument) return undefined;
    const desktop = viewportWidth >= 900;
    const zoom = scale / 1.35;
    const available = Math.max(240, frameWidth - (hasReadingGutter ? 532 : 40));
    return { document:formattedDocument, pages:showPages, font:readingFont, size:readingSize * (desktop ? .9 : 1) * zoom, leading:readingLeading, width:Math.min(available, (desktop ? 792 : 880) * zoom) };
  }, [formatted, formattedDocument, frameWidth, hasReadingGutter, readingFont, readingLeading, readingSize, scale, showPages, viewportWidth]);
  // In overlap mode the paper starts at the rail edge minus a small, shared
  // overlap. The same geometry reserves the paper and note margin before
  // fitting the page, so the layout never needs horizontal scrolling.
  const compactPdf = !formatted && viewportWidth <= 600;
  const overlapRailWidth = compactPdf ? 44 : Math.min(176, Math.max(96, frameWidth * .2));
  const overlapPaperOverlap = overlapRailWidth * .25;
  const overlapNoteWidth = Math.min(196, Math.max(72, frameWidth * .24));
  const overlapNoteOverlap = Math.min(22, Math.max(14, overlapNoteWidth * .12));
  const overlapPageOffset = Math.max(0, overlapRailWidth - overlapPaperOverlap);
  const compressedNotesHidden = !laptopLayout && noteVisibility === "none";
  const scriptRailWidth = railLaptop ? 220 : overlapRailWidth;
  const scriptRailCardLeft = railLaptop ? 10 : 0;
  const scriptRailCardWidth = railLaptop ? 196 : overlapRailWidth;
  const zoomGeometry = useMemo(() => {
    // The rail overlays the paper in overlap mode, but the right margin is a
    // real column. Reserve that column before scaling so saved notes never sit
    // on top of script text or create horizontal overflow.
    const reservedWidth = compactPdf ? overlapPageOffset + 8 : laptopLayout
      ? 526
      : compressedNotesHidden
        ? overlapPageOffset + 8
        : overlapNoteWidth + overlapPageOffset - overlapNoteOverlap + 8;
    // Historical compatibility rule: return intermediate ? fitScale : Math.min(scale, fitScale).
    return getPdfZoomGeometry({
      frameWidth,
      reservedWidth,
      requestedScale: scale,
      pageWidth: PDF_WIDTH,
      // Compact notes are icons inside the paper. Their former card column
      // still gives the fitted view breathing room, but is not scrollable ink.
      pageOffset: laptopLayout ? reservedWidth : overlapPageOffset,
      minimumFitScale: laptopLayout ? .35 : .12,
    });
  }, [compactPdf, compressedNotesHidden, frameWidth, laptopLayout, overlapNoteOverlap, overlapNoteWidth, overlapPageOffset, scale]);
  const responsiveScale = zoomGeometry.renderedScale * (viewportWidth >= 900 ? .9 : 1);
  useLayoutEffect(() => {
    const viewer = viewerRef.current;
    const frame = viewer?.closest<HTMLElement>(".pdf-frame");
    if (!viewer || !frame) return;
    // Broad ancestor :has() selectors searched the complete script whenever a
    // cue changed class. Publish layout once at the nodes that consume it.
    frame.dataset.readerFormat = formatted ? "formatted" : "pdf";
    frame.dataset.readerLayout = layoutMode;
    frame.dataset.horizontalScrollable = String(zoomGeometry.horizontallyScrollable);
    const readerLayout = formatted ? layoutMode : "pdf";
    const canvas = frame.closest<HTMLElement>(".script-canvas");
    const shell = frame.closest<HTMLElement>(".app-shell");
    if (canvas) canvas.dataset.readerLayout = readerLayout;
    if (shell) shell.dataset.readerLayout = readerLayout;
    // Preserve attributes through Activity hide/show, like the retained DOM.
  }, [formatted, layoutMode, status, zoomGeometry.horizontallyScrollable]);
  const cueJumpScale = formatted ? 0 : responsiveScale;
  const restoredReading = useRef<ReadingOptions | undefined>(undefined);
  useLayoutEffect(() => {
    const viewer = viewerRef.current;
    const frame = viewer?.closest<HTMLElement>(".pdf-frame");
    const position = readingPosition.current;
    if (!reading || !viewer || !frame) return;
    const changed = restoredReading.current !== reading;
    restoredReading.current = reading;
    if (!position || !changed) return;
    restoringReading.current = true;
    let tick = 0, cancelled = false;
    let settledAt = performance.now() + 350;
    const restore = () => {
      if (cancelled) return;
      const word = viewer.querySelector<HTMLElement>(`.reader-word[data-source-line="${position.line}"][data-source-word="${position.word}"]`);
      if (word) frame.scrollTo({ top:frame.scrollTop + word.getBoundingClientRect().top - frame.getBoundingClientRect().top - position.top, behavior:"instant" });
      if (performance.now() < settledAt) tick = requestAnimationFrame(restore);
      else restoringReading.current = false;
    };
    // Marker clearance is measured after text reflows. Keep the same source
    // word fixed through that second layout, even on a busy frame.
    const reflow = new ResizeObserver(() => {
      if (cancelled) return;
      cancelAnimationFrame(tick);
      settledAt = performance.now() + 100;
      restoringReading.current = true;
      restore();
    });
    const sourcePage = viewer.querySelector<HTMLElement>(`.reader-word[data-source-line="${position.line}"][data-source-word="${position.word}"]`)?.closest<HTMLElement>(".formatted-page-text");
    if (sourcePage) reflow.observe(sourcePage);
    const cancel = () => { cancelled = true; cancelAnimationFrame(tick); reflow.disconnect(); restoringReading.current = false; };
    const cancelInteraction = () => { readingPositionPinned.current = false; cancel(); };
    const cancelKeyboard = (event: KeyboardEvent) => { if (["ArrowDown","ArrowUp","ArrowLeft","ArrowRight","PageDown","PageUp","Home","End"," "].includes(event.key)) cancelInteraction(); };
    frame.addEventListener("wheel", cancelInteraction, { passive:true });
    frame.addEventListener("touchstart", cancelInteraction, { passive:true });
    window.addEventListener("pointerdown", cancelInteraction);
    window.addEventListener("keydown", cancelKeyboard);
    tick = requestAnimationFrame(restore);
    return () => { cancel(); frame.removeEventListener("wheel", cancelInteraction); frame.removeEventListener("touchstart", cancelInteraction); window.removeEventListener("pointerdown", cancelInteraction); window.removeEventListener("keydown", cancelKeyboard); };
  }, [reading]);
  useEffect(() => {
    const viewer = viewerRef.current;
    const frame = viewer?.closest<HTMLElement>(".pdf-frame");
    const controls = viewer?.querySelector<HTMLElement>(".script-reading-controls");
    if (!frame) return;
    const update = () => frame.style.setProperty("--reader-toolbar-height", `${controls ? controls.offsetHeight + 16 : 0}px`);
    const observer = new ResizeObserver(update);
    if (controls) observer.observe(controls); update();
    // Keep the inherited value through Activity hide/show. Removing and
    // resetting it restyled every word twice on each tab switch.
    return () => { observer.disconnect(); };
  }, [formattedDocument, readingView, layoutMode, status]);
  const markerScale = cueMarkerScaleForZoom(scale / 1.35);
  const hoverInput = useHoverInput();
  const tapOnlyMode = !hoverInput;
  const railConnectorGap = railLaptop ? 42 : 0;
  const handleVisiblePage = useCallback((pageNumber: number) => {
    if (visiblePageRef.current !== pageNumber) {
      visiblePageRef.current = pageNumber;
      setVisiblePage(pageNumber);
    }
    if (pendingJumpPageRef.current !== null) {
      if (jumpSettledTimerRef.current !== null) window.clearTimeout(jumpSettledTimerRef.current);
      if (pageNumber !== pendingJumpPageRef.current) return;
      // Mounting nearby content can adjust scroll geometry after the reading
      // line first reaches the destination. Keep its label until it settles.
      jumpSettledTimerRef.current = window.setTimeout(() => {
        if (!settlingPageJumpRef.current && pendingJumpPageRef.current === pageNumber) pendingJumpPageRef.current = null;
        jumpSettledTimerRef.current = null;
      }, 200);
    }
    if (reportedPageRef.current === pageNumber) return;
    reportedPageRef.current = pageNumber;
    onVisiblePage(pageNumber);
  }, [onVisiblePage]);

  useEffect(() => () => {
    if (jumpSettledTimerRef.current !== null) window.clearTimeout(jumpSettledTimerRef.current);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const updatePointer = () => setPointerFine(query.matches);
    updatePointer();
    query.addEventListener?.("change", updatePointer);
    return () => query.removeEventListener?.("change", updatePointer);
  }, []);

  useEffect(() => {
    const readViewport = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
      const frameElement = viewerRef.current?.closest<HTMLElement>(".pdf-frame");
      if (frameElement) setFrameWidth(frameElement.clientWidth);
    };
    let frame = window.requestAnimationFrame(readViewport);
    const updateWidth = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(readViewport);
    };
    window.addEventListener("resize", updateWidth);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener("resize", updateWidth); };
  }, [status]);

  useLayoutEffect(() => {
    const frame = viewerRef.current?.closest<HTMLElement>(".pdf-frame");
    if (!frame) return;
    const updateFrameWidth = () => setFrameWidth(frame.clientWidth);
    const observer = new ResizeObserver(updateFrameWidth);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [status, selectedCueId]);

  useEffect(() => {
    const pageElement = pageElements.current.get(visiblePage);
    const frame = pageElement?.closest(".pdf-frame");
    if (!frame) {
      setRailPosition(null);
      setNextCueId(null);
      return;
    }
    let animationFrame = 0;
    const updateScrollContext = () => {
      const rail = pageElements.current.get(visiblePage)?.querySelector<HTMLElement>(".aligned-cue-rail");
      const frameRect = frame.getBoundingClientRect();
      const visibleStage = pageElements.current.get(visiblePage)?.querySelector<HTMLElement>(".pdf-page-stage");
      if (visibleStage) {
        const stageRect = visibleStage.getBoundingClientRect();
        const sourceWord = [...visibleStage.querySelectorAll<HTMLElement>(".reader-word")].find(word => { const rect = word.getBoundingClientRect(); return rect.bottom >= frameRect.top + 90 && rect.left >= stageRect.left && rect.left < stageRect.right; });
        if (sourceWord && !restoringReading.current && !readingPositionPinned.current) readingPosition.current = { line:sourceWord.dataset.sourceLine!, word:sourceWord.dataset.sourceWord!, top:sourceWord.getBoundingClientRect().top - frameRect.top };
        const anchorY = sourceWord ? Number(sourceWord.dataset.sourceY) : Math.max(0, Math.min(1, (frameRect.top + 90 - stageRect.top) / stageRect.height));
        const visibleScene = locateScene(visiblePage, anchorY);
        if (visibleScene) onVisibleScene(visibleScene.id);
      }
      const activeScene = sceneContexts.findLast((context) => {
        const slot = pageElements.current.get(context.pageStart);
        if (!slot) return false;
        const slotRect = slot.getBoundingClientRect();
        if (slotRect.top > frameRect.top + 64) return false;
        if (slotRect.bottom <= frameRect.top + 64) return true;
        const stage = slot.querySelector<HTMLElement>(".pdf-page-stage");
        if (!stage) return false;
        const stageRect = stage.getBoundingClientRect();
        if(stageRect.top>frameRect.top+64)return false;
        if(stageRect.bottom<=frameRect.top+64)return true;
        return (readingTarget(stage, context.startY)?.getBoundingClientRect().top ?? stageRect.top + context.startY * stageRect.height) <= frameRect.top + 64;
      });
      setActiveSceneGroupId((current) => current === activeScene?.id ? current : activeScene?.id ?? null);
      const nextCue = orderedCues.find((cue) => {
        const slot = pageElements.current.get(cue.page);
        if (!slot) return false;
        const slotRect = slot.getBoundingClientRect();
        if (slotRect.bottom <= frameRect.bottom) return false;
        if (slotRect.top > frameRect.bottom) return true;
        const stage = slot.querySelector<HTMLElement>(".pdf-page-stage");
        if (!stage) return false;
        const stageRect = stage.getBoundingClientRect();
        if(stageRect.bottom<=frameRect.bottom)return false;
        if(stageRect.top>frameRect.bottom)return true;
        const anchorY = Math.max(0, Math.min(1, cue.anchorY ?? .12));
        const marker = stage.querySelector<HTMLElement>(`.reader-cue-marker[data-cue-id="${CSS.escape(cue.id)}"]`);
        if (formatted && !marker) return false;
        return (marker?.getBoundingClientRect().top ?? stageRect.top + anchorY * stageRect.height) > frameRect.bottom;
      });
      setNextCueId((current) => current === (nextCue?.id ?? null) ? current : nextCue?.id ?? null);
      setRailPosition((current) => {
        if (!rail) return null;
        const railRect = rail.getBoundingClientRect();
        const position = { left: railRect.left + (railLaptop ? 10 : 0), bottom: Math.max(12, window.innerHeight - frameRect.bottom + 16), width: railLaptop ? Math.min(196, railRect.width) : railRect.width + overlapPaperOverlap };
        return current?.left === position.left && current.bottom === position.bottom && current.width === position.width ? current : position;
      });
    };
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(updateScrollContext);
    };
    updateScrollContext();
    window.addEventListener("resize", scheduleUpdate);
    frame.addEventListener("scroll", scheduleUpdate, { passive: true });
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(frame);
    return () => { window.cancelAnimationFrame(animationFrame); window.removeEventListener("resize", scheduleUpdate); frame.removeEventListener("scroll", scheduleUpdate); observer.disconnect(); };
  }, [formatted, railLaptop, locateScene, onVisibleScene, orderedCues, overlapPaperOverlap, responsiveScale, sceneContexts, status, visiblePage]);

  useEffect(() => {
    let disposed = false;
    const resource = acquireScriptDocument();
    resource.promise.then(async ({ pdfjs, pdf }) => {
      if (disposed) return;
      setPdfjs(pdfjs);
      setPdf(pdf);
      setStatus("ready");
      // The original document is usable even if its optional reading copy stalls.
      const document = await loadFormattedDocument(pdf);
      if (!disposed) setFormattedDocument(document);
    }).catch(() => { if (!disposed) setStatus("error"); });
    return () => { disposed = true; resource.release(); };
  }, []);

  useEffect(() => {
    if (!selectedCueId || !selectedCuePage) {
      completedCueJumpRef.current = null;
      return;
    }
    if (!pdf) return;
    const key = `${selectedCueId}:${selectedCuePage}`;
    if (jumpRequest?.preserveCueId === selectedCueId) {
      completedCueJumpRef.current = key;
      return;
    }
    if (completedCueJumpRef.current === key) return;
    const targetPage = Math.max(firstScriptPage, Math.min(pdf.numPages, selectedCuePage));
    pendingJumpPageRef.current = targetPage;
    reportedPageRef.current = null;
    const timer = window.setTimeout(() => {
      completedCueJumpRef.current = key;
      const cue = selectedCueRef.current;
      const row = pageElements.current.get(targetPage);
      const frame = row?.closest<HTMLElement>(".pdf-frame");
      const stage = row?.querySelector<HTMLElement>(".pdf-page-stage");
      if (!cue || !row || !frame || !stage) {
        row?.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      const frameRect = frame.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const anchorY = Math.max(0, Math.min(1, cue.anchorY ?? .12));
      const marker = [...stage.querySelectorAll<HTMLElement>(".reader-cue-marker")].find(marker => marker.dataset.cueId === cue.id);
      if (marker) revealReadingTarget(marker);
      const renderedTop = marker?.getBoundingClientRect().top ?? stageRect.top + anchorY * stageRect.height;
      const toolbarHeight = viewerRef.current?.querySelector<HTMLElement>(".script-reading-controls")?.offsetHeight ?? 0;
      if (marker && renderedTop > frameRect.top + toolbarHeight && renderedTop < frameRect.bottom - 60) return;
      frame.scrollTo({ top: Math.max(0, frame.scrollTop + renderedTop - frameRect.top - Math.max(toolbarHeight + 20, frame.clientHeight * .3)), behavior: "smooth" });
    }, 80);
    const cancel = () => {
      if (pendingJumpPageRef.current !== targetPage) return;
      completedCueJumpRef.current = key;
      window.clearTimeout(timer);
      const frame = viewerRef.current?.closest<HTMLElement>(".pdf-frame");
      frame?.scrollTo({ top: frame.scrollTop, behavior: "instant" });
      if (cancelCueJumpRef.current === cancel) cancelCueJumpRef.current = null;
    };
    cancelCueJumpRef.current = cancel;
    return () => {
      window.clearTimeout(timer);
      if (cancelCueJumpRef.current === cancel) cancelCueJumpRef.current = null;
    };
  }, [firstScriptPage, jumpRequest, pdf, cueJumpScale, selectedCueId, selectedCuePage]);

  useLayoutEffect(() => {
    if (!pdf || !jumpRequest) return;
    // A completed or cancelled request must never replay after a later resize.
    if (completedPageJumpRef.current === jumpRequest.key) return;
    const targetPage = Math.max(firstScriptPage, Math.min(pdf.numPages, jumpRequest.page));
    const row = pageElements.current.get(targetPage);
    const frame = row?.closest<HTMLElement>(".pdf-frame");
    if (!row || !frame) return;
    pendingJumpPageRef.current = targetPage;
    settlingPageJumpRef.current = true;
    reportedPageRef.current = null;
    let finished = false;
    let scrolling = true;
    let settledTimer = 0;
    const destination = () => {
      // At the top boundary, resizing must not turn the fixed header offset
      // into a new scroll when the editor closes.
      if (jumpRequest.preserveTop) return 0;
      const stage = row?.querySelector<HTMLElement>(".pdf-page-stage");
      if (!stage) return frame.scrollTop;
      const frameRect = frame.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const target = readingTarget(stage, jumpRequest.anchorY ?? 0);
      revealReadingTarget(target);
      return Math.max(0, frame.scrollTop + (target?.getBoundingClientRect().top ?? stageRect.top + (jumpRequest.anchorY ?? 0) * stageRect.height) - frameRect.top - (jumpRequest.anchorY == null ? 18 : 84));
    };
    // Nearby rails can grow when virtual pages mount, moving the destination
    // underneath a smooth scroll. Reconcile its actual position after scrolling
    // and each layout change, then release the page label once it is stable.
    const align = () => {
      if (finished || pendingJumpPageRef.current !== targetPage) return;
      scrolling = false;
      window.clearTimeout(settledTimer);
      const top = destination();
      if (Math.abs(frame.scrollTop - top) > 1) frame.scrollTo({ top, behavior: "instant" });
      settledTimer = window.setTimeout(() => {
        // PDF dimensions and rail heights can arrive after the first alignment.
        // Also recheck WebKit's position after cancelling its smooth scroll.
        const loadingBeforeTarget = [...pageElements.current].some(([page, slot]) => page <= targetPage && slot.querySelector(".pdf-page-stage.loading"));
        if (loadingBeforeTarget || Math.abs(frame.scrollTop - destination()) > 1) {
          align();
          return;
        }
        finished = true;
        completedPageJumpRef.current = jumpRequest.key;
        settlingPageJumpRef.current = false;
        if (cancelPageJumpRef.current === cancel) cancelPageJumpRef.current = null;
        if (pendingJumpPageRef.current === targetPage) pendingJumpPageRef.current = null;
      }, 200);
    };
    const observer = new ResizeObserver(() => { if (!scrolling) align(); });
    if (viewerRef.current) observer.observe(viewerRef.current);
    observer.observe(row);
    frame.addEventListener("scrollend", align);
    // Panel closure restores the reading position before paint. The observer
    // keeps it aligned while resized PDF pages and cue rails finish loading.
    if (jumpRequest.preservePosition) {
      frame.scrollTo({ top: frame.scrollTop, behavior: "instant" });
      align();
    }
    const timer = jumpRequest.preservePosition ? 0 : window.setTimeout(() => {
      frame.scrollTo({ top: destination(), behavior: "smooth" });
    }, 80);
    // A scroll that starts at its destination need not emit scrollend.
    const fallback = window.setTimeout(align, 1000);
    const cancel = () => {
      finished = true;
      completedPageJumpRef.current = jumpRequest.key;
      settlingPageJumpRef.current = false;
      window.clearTimeout(timer);
      window.clearTimeout(fallback);
      window.clearTimeout(settledTimer);
      frame.scrollTo({ top: frame.scrollTop, behavior: "instant" });
      if (cancelPageJumpRef.current === cancel) cancelPageJumpRef.current = null;
    };
    cancelPageJumpRef.current = cancel;
    return () => {
      finished = true;
      settlingPageJumpRef.current = false;
      window.clearTimeout(timer);
      window.clearTimeout(fallback);
      window.clearTimeout(settledTimer);
      frame.removeEventListener("scrollend", align);
      observer.disconnect();
      if (cancelPageJumpRef.current === cancel) cancelPageJumpRef.current = null;
    };
  }, [firstScriptPage, jumpRequest, pdf, responsiveScale]);

  const lastPage = pdf?.numPages ?? pageCount;
  const pages = Array.from({ length: Math.max(0, lastPage - firstScriptPage + 1) }, (_, index) => index + firstScriptPage);
  const pageObserver = useRef<IntersectionObserver | null>(null);
  const [renderEpoch, setRenderEpoch] = useState(0);
  const [activePages, setActivePages] = useState<ReadonlySet<number>>(() => new Set());
  const registerPage = useCallback((pageNumber: number, element: HTMLDivElement | null) => {
    const previous = pageElements.current.get(pageNumber);
    if (previous) pageObserver.current?.unobserve(previous);
    if (element) {
      pageElements.current.set(pageNumber, element);
      pageObserver.current?.observe(element);
    } else pageElements.current.delete(pageNumber);
  }, []);
  useEffect(() => {
    if (status !== "ready") return;
    const frame = viewerRef.current?.closest<HTMLElement>(".pdf-frame");
    if (!frame) return;
    let refreshFrame = 0;
    const refreshActivePages = () => {
      refreshFrame = 0;
      if (document.visibilityState === "hidden" || !viewerRef.current?.getBoundingClientRect().height) return;
      const bounds = frame.getBoundingClientRect();
      const next = new Set<number>();
      pageElements.current.forEach((element, page) => {
        const pageBounds = element.getBoundingClientRect();
        if (pageBounds.bottom >= bounds.top - 1200 && pageBounds.top <= bounds.bottom + 1200) next.add(page);
      });
      setActivePages((previous) => next.size === previous.size && [...next].every((page) => previous.has(page)) ? previous : next);
    };
    const scheduleRefresh = () => {
      if (!refreshFrame) refreshFrame = window.requestAnimationFrame(refreshActivePages);
    };
    // Observer entries describe a past layout. A late batch must not undo a
    // newer scroll reconciliation, so both paths measure the current geometry.
    const observer = new IntersectionObserver(scheduleRefresh, { root: frame, rootMargin: "1200px 0px" });
    pageObserver.current = observer;
    pageElements.current.forEach((element) => observer.observe(element));
    const refreshAfterVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const frame = viewerRef.current?.closest(".pdf-frame");
      if (!frame) return;
      const bounds = frame.getBoundingClientRect();
      const isNear = bounds.height > 0;
      // Restore visible canvases after OS suspension; inactive slots stay cheap.
      if (isNear) {
        refreshActivePages();
        setRenderEpoch((epoch) => epoch + 1);
      }
    };
    // Safari may defer observer delivery during momentum scrolling. Reconcile
    // the current geometry as well, including after a rapid reversal or jump.
    refreshActivePages();
    frame.addEventListener("scroll", scheduleRefresh, { passive: true });
    frame.addEventListener("scrollend", scheduleRefresh);
    window.addEventListener("resize", scheduleRefresh);
    document.addEventListener("visibilitychange", refreshAfterVisibilityChange);
    window.addEventListener("pageshow", refreshAfterVisibilityChange);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(refreshFrame);
      frame.removeEventListener("scroll", scheduleRefresh);
      frame.removeEventListener("scrollend", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
      pageObserver.current = null;
      document.removeEventListener("visibilitychange", refreshAfterVisibilityChange);
      window.removeEventListener("pageshow", refreshAfterVisibilityChange);
    };
  }, [status]);
  const cuesByPage = useMemo(() => {
    const map = new Map<number, Cue[]>();
    for (const cue of cues) {
      const list = map.get(cue.page) ?? [];
      list.push(cue);
      map.set(cue.page, list);
    }
    return map;
  }, [cues]);
  const discussionsByPage = useMemo(() => {
    const cuePages = new Map(cues.map((cue) => [cue.id, cue.page]));
    const scenePages = new Map(scenes.map((scene) => [scene.id, scene.pageStart]));
    const map = new Map<number, Discussion[]>();
    for (const discussion of discussions) {
      const page = discussionPage(discussion, cuePages, scenePages);
      if (!page) continue;
      const list = map.get(page) ?? [];
      list.push(discussion);
      map.set(page, list);
    }
    return map;
  }, [cues, discussions, scenes]);

  useEffect(() => {
    if (status !== "ready" || !pdf) return;
    const frame = viewerRef.current?.closest<HTMLElement>(".pdf-frame");
    if (!frame) return;
    let animationFrame = 0;
    const pageTop = (page: number) => pageElements.current.get(page)?.getBoundingClientRect().top;
    const updateVisiblePage = () => {
      if (document.visibilityState === "hidden") return;
      const frameRect = frame.getBoundingClientRect();
      const readingLine = frameRect.top + Math.min(90, frame.clientHeight * .3);
      const deadZone = Math.min(32, frame.clientHeight * .06);
      let page = Math.max(firstScriptPage, Math.min(pdf.numPages, visiblePageRef.current));
      // Keep the current page while its boundary is close to the reading line.
      // Only cross the far side of the dead zone when scrolling back.
      while (page < pdf.numPages && (pageTop(page + 1) ?? Infinity) < readingLine - deadZone) page++;
      while (page > firstScriptPage && (pageTop(page) ?? -Infinity) > readingLine + deadZone) page--;
      handleVisiblePage(page);
    };
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(updateVisiblePage);
    };
    scheduleUpdate();
    frame.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    document.addEventListener("visibilitychange", scheduleUpdate);
    const cancelJump = () => {
      // Stop the actual timers and smooth scroll, as well as its page label.
      cancelCueJumpRef.current?.();
      cancelPageJumpRef.current?.();
      if (jumpSettledTimerRef.current !== null) window.clearTimeout(jumpSettledTimerRef.current);
      jumpSettledTimerRef.current = null;
      pendingJumpPageRef.current = null;
      reportedPageRef.current = null;
      scheduleUpdate();
    };
    const cancelKeyboardJump = (event: KeyboardEvent) => {
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) cancelJump();
    };
    frame.addEventListener("wheel", cancelJump, { passive: true });
    frame.addEventListener("touchstart", cancelJump, { passive: true });
    frame.addEventListener("pointerdown", cancelJump);
    frame.addEventListener("keydown", cancelKeyboardJump);
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(frame);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      frame.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      document.removeEventListener("visibilitychange", scheduleUpdate);
      frame.removeEventListener("wheel", cancelJump);
      frame.removeEventListener("touchstart", cancelJump);
      frame.removeEventListener("pointerdown", cancelJump);
      frame.removeEventListener("keydown", cancelKeyboardJump);
      observer.disconnect();
    };
  }, [firstScriptPage, handleVisiblePage, pdf, responsiveScale, status]);

  const scrollToCue = useCallback((cueId: string) => {
    const cue = cues.find((item) => item.id === cueId);
    const row = cue ? pageElements.current.get(cue.page) : null;
    const frame = row?.closest<HTMLElement>(".pdf-frame");
    const stage = row?.querySelector<HTMLElement>(".pdf-page-stage");
    if (!cue || !frame || !stage) return;
    const frameRect = frame.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const anchorY = Math.max(0, Math.min(1, cue.anchorY ?? .12));
    const target = [...stage.querySelectorAll<HTMLElement>(".reader-cue-marker")].find(marker => marker.dataset.cueId === cue.id);
    revealReadingTarget(target);
    const anchorTop = target?.getBoundingClientRect().top ?? stageRect.top + anchorY * stageRect.height;
    frame.scrollTo({ top: Math.max(0, frame.scrollTop + anchorTop - frameRect.top - frame.clientHeight * .3), behavior: "smooth" });
  }, [cues]);

  const selectReadingCue = useCallback((cueId: string, notes = false) => {
    const viewer = viewerRef.current;
    const frame = viewer?.closest<HTMLElement>(".pdf-frame");
    const marker = [...(viewer?.querySelectorAll<HTMLElement>(".reader-cue-marker") ?? [])].find(marker => marker.dataset.cueId === cueId);
    const word = marker?.parentElement?.querySelector<HTMLElement>(".reader-word");
    if (word && frame) {
      readingPosition.current = { line:word.dataset.sourceLine!, word:word.dataset.sourceWord!, top:word.getBoundingClientRect().top - frame.getBoundingClientRect().top };
      readingPositionPinned.current = true;
    }
    if (notes) onOpenCueNotes(cueId);
    else onSelectCue(cueId);
  }, [onOpenCueNotes, onSelectCue]);

  const nextControlCue = orderedCues.find(cue => cue.id === nextCueId);
  const nextControlWidth = nextControlCue ? Math.max(50, markerLabel(nextControlCue.number).length * 9.7 + 20) : 50;
  useEffect(() => {
    const shell = viewerRef.current?.closest<HTMLElement>(".app-shell");
    shell?.style.setProperty("--next-cue-width", `${nextControlWidth}px`);
    // The shell owns this value until it unmounts; hiding Script is not a reset.
  }, [nextControlWidth, status]);

  const pageEvents = useStableEvents({
    setCommentText: setCommentText,
    onCancelPendingNote: onCancelPendingNote,
    onPostPendingNote: onPostPendingNote,
    onSelectCue: selectReadingCue,
    onOpenCueNotes: (id: string) => selectReadingCue(id, true),
    onOpenScene: onOpenScene,
    onAnchorChosen: onAnchorChosen,
    onNoteTarget: onNoteTarget,
    onPlaceNote: onPlaceNote,
    onReplyNote: onReplyNote,
    onOpenDiscussion: onOpenDiscussion,
    onDismissDiscussion: onDismissDiscussion,
    setReplyText: setReplyText,
    startReply: startReply,
    cancelReply: cancelReply,
    postReply: postReply,
    toggleResolved: toggleResolved,
    onMoveCue: onMoveCue,
    onDeleteCue: onDeleteCue,
    onToggleCueMode: onToggleCueMode,
    onToggleCueBlackout: onToggleCueBlackout,
    onEditCueNumber: onEditCueNumber,
    onUnassignCueNumber: onUnassignCueNumber,
  });

  if (status !== "ready" || !pdf || !pdfjs) {
    return <div className={`continuous-pdf-status ${status}`}>
      {status === "error" ? <><b>PDF COULD NOT LOAD</b><span>Retrying the script connection may resolve this.</span><button onClick={() => window.location.reload()}>Retry</button></> : <><i /> Loading complete script…</>}
    </div>;
  }

  const nextVisibleCue = orderedCues.find((cue) => cue.id === nextCueId);
  const nextVisibleCueScene = nextVisibleCue ? scenes.find((scene) => scene.id === nextVisibleCue.sceneId) : undefined;
  const activeSceneContext = sceneContexts.find((context) => context.id === activeSceneGroupId);
  const contextAtPosition = (page: number, anchorY: number) => {
    const position = page - 1 + anchorY;
    return sceneContexts.findLast((context) => context.pageStart - 1 + context.startY <= position) ?? null;
  };
  const readingScene = activeSceneContext ?? contextAtPosition(visiblePage, .5);
  const stickyScene = activeSceneContext ?? readingScene;
  const visibleNotes = discussions.filter(note => noteVisibility !== "none" && (noteVisibility === "all" || !note.resolved));
  const focusedNote = visibleNotes.find(note => note.id === focusedDiscussionId && discussionTargetType(note) !== "cue");
  const noteSource = (note: Discussion) => formattedDocument ? resolveCueSource(formattedDocument, { page:note.page ?? 1, anchorType:"phrase", selectedText:note.selectedText ?? "", enclosingLine:note.enclosingLine ?? "", anchorX:note.anchorX, anchorY:note.anchorY }) : null;
  const focusedSource = focusedNote && noteSource(focusedNote);
  const focusedNotes = focusedNote ? visibleNotes.filter(note => {
    if (discussionTargetType(note) === "cue") return false;
    if (discussionTargetType(focusedNote) === "scene") return discussionTargetType(note) === "scene" && note.sceneId === focusedNote.sceneId;
    if (discussionTargetType(note) !== "script" || note.page !== focusedNote.page) return false;
    const source = noteSource(note);
    return focusedSource && source ? source.lineId === focusedSource.lineId && source.word === focusedSource.word : note.anchorY === focusedNote.anchorY && note.anchorX === focusedNote.anchorX;
  }) : [];
  const currentSceneNotes = readingScene ? visibleNotes.filter(note => discussionTargetType(note) === "scene" && note.sceneId === readingScene.firstSceneId) : [];
  return <div ref={viewerRef} className={`continuous-script ${formatted ? `formatted-script ${showPages ? "with-pages" : "without-pages"}` : ""} layout-${layoutMode} ${compactPdf ? "compact-pdf" : ""} ${zoomGeometry.horizontallyScrollable ? "horizontal-scrollable" : ""} ${anchorMode ? "choosing-anchor" : ""} ${tapOnlyMode ? "tap-only" : "supports-hover"}`} style={{ "--reader-paper-width": `${reading?.width ?? PDF_WIDTH * responsiveScale}px`, "--scene-header-height": "128px", "--script-rail-width": `${scriptRailWidth}px`, "--script-rail-card-left": `${scriptRailCardLeft}px`, "--script-rail-card-width": `${scriptRailCardWidth}px`, "--script-note-width": `${overlapNoteWidth}px`, "--script-paper-overlap": `${overlapPaperOverlap}px`, "--script-note-overlap": `${overlapNoteOverlap}px`, "--overlap-page-offset": `${overlapPageOffset}px` } as CSSProperties}>
    {layoutMode === "overlap" && readingScene && <div className="script-reading-controls" role="group" aria-label="Current scene"><SceneRailCard compact scene={readingScene} onClick={() => noteMode ? onNoteTarget({ type:"scene", id:readingScene.firstSceneId }, { page:visiblePage, selectedText:"", enclosingLine:readingScene.name, anchorX:.05, anchorY:readingScene.startY }) : onOpenScene(readingScene.firstSceneId)} />{currentSceneNotes.length > 0 && <button type="button" className="scene-note-marker reader-note-icon" aria-label={`Open ${currentSceneNotes.length} scene notes`} onClick={() => onOpenDiscussion(currentSceneNotes[0].id)}><NoteIcon />{currentSceneNotes.length > 1 && <b>{currentSceneNotes.length}</b>}</button>}</div>}
    {stickyScene && !compactPdf && <div className="sticky-scene-row"><SceneRailCard key={stickyScene.id} scene={stickyScene} onClick={() => onOpenScene(stickyScene.firstSceneId)} /><span className="sticky-page-spacer" style={{ width: reading?.width ?? PDF_WIDTH * responsiveScale }} /></div>}
    {nextVisibleCue && (viewportWidth < 900 || formatted && layoutMode === "overlap" ? <button type="button" className="next-offscreen-cue" style={{width:nextControlWidth,borderRadius:25}} data-cue-id={nextVisibleCue.id} aria-label={`Next offscreen cue: ${cueLabel(nextVisibleCue)} ${nextVisibleCue.title}`} onClick={() => scrollToCue(nextVisibleCue.id)}><b>{markerLabel(nextVisibleCue.number)}</b><span aria-hidden="true"><ArrowIcon direction="down" /></span></button> : railPosition && <button className={`next-cue-card ${nextVisibleCue.mode} ${nextVisibleCue.blackout ? "blackout" : ""}`} style={railPosition} onClick={() => scrollToCue(nextVisibleCue.id)}><span>NEXT CUE · PAGE {scriptPageNumber(nextVisibleCue.page)}</span><b>{cueLabel(nextVisibleCue)} · {nextVisibleCue.title}</b><small>{nextVisibleCueScene ? `SCENE ${nextVisibleCueScene.number} · ${nextVisibleCueScene.name}` : "Scene unassigned"}</small><em>{nextVisibleCue.anchorType === "line" ? "LINE" : "WORD"}{nextVisibleCue.blackout ? " · BLACKOUT" : ""} · {nextVisibleCue.mode === "implemented" ? "IMPLEMENTED" : nextVisibleCue.mode === "unassigned" ? "UNASSIGNED" : "PLANNED"}</em><i>{nextVisibleCue.description || "No lighting intention yet."}</i></button>)}
    {layoutMode === "overlap" && focusedNote && focusedNotes.length > 0 && <ScriptNoteSheet key={focusedNotes[0].id} notes={focusedNotes} profiles={profiles} onOpen={onOpenDiscussion} onDismiss={onDismissDiscussion} busy={busyGroups.has(`discussion:${focusedNote.id}`)} onStartReply={startReply} onCancelReply={cancelReply} onPostReply={postReply} onToggleResolved={toggleResolved} replyingToId={replyingToId} replyText={replyText} setReplyText={setReplyText} />}
    {layoutMode === "overlap" && <div className="overlap-zoom-control" role="group" aria-label="Script zoom"><button type="button" aria-label="Zoom out" onClick={onZoomOut}>−</button><span aria-live="polite">{zoomLabel}</span><button type="button" aria-label="Zoom in" onClick={onZoomIn}>＋</button></div>}
    <div className="script-page-flow">{pages.map((pageNumber) => <PdfPageSlot {...pageEvents}
      active={formatted || activePages.has(pageNumber)}
      nearViewport={activePages.has(pageNumber)}
      reading={reading}
      renderEpoch={renderEpoch}
      key={pageNumber}
      pdf={pdf}
      pdfjs={pdfjs}
      pageNumber={pageNumber}
      scale={responsiveScale}
      markerScale={markerScale}
      layoutMode={layoutMode}
      compactPdf={compactPdf}
      railConnectorGap={railConnectorGap}
      tapOnlyMode={tapOnlyMode}
      hoverCapable={hoverInput}
      cues={cuesByPage.get(pageNumber) ?? EMPTY_CUES}
      profiles={profiles}
      discussionCounts={discussionCounts}
      noteVisibility={noteVisibility}
      sceneContext={contextAtPosition(pageNumber, .5)}
      stickySceneId={formatted && sceneBoundariesByPage.get(pageNumber)?.some(boundary => boundary.firstSceneId === stickyScene?.firstSceneId) ? stickyScene?.firstSceneId : undefined}
      sceneBoundaries={sceneBoundariesByPage.get(pageNumber) ?? EMPTY_SCENE_BOUNDARIES}
      discussions={discussionsByPage.get(pageNumber) ?? EMPTY_DISCUSSIONS}
      selectedCueId={cuesByPage.get(pageNumber)?.some(cue => cue.id === selectedCueId) ? selectedCueId : null}
      anchorMode={anchorMode}
      outOfOrderCueIds={outOfOrderCueIds}
      pendingNote={pendingNote}
      commentText={commentText}
      registerPage={registerPage}
      noteMode={noteMode}
      focusedDiscussionId={focusedDiscussionId}
      replyingToId={replyingToId}
      replyText={replyText}
      busyGroups={busyGroups}
    />)}</div>
  </div>;
}

const PdfPageSlot = memo(function PdfPageSlot({ active, nearViewport, ...props }: ComponentProps<typeof PdfPage> & { active: boolean; nearViewport: boolean }) {
  const slot = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ height: number; scale: number; reading: ReadingOptions | undefined } | null>(null);
  const { pageNumber, registerPage, scale } = props;
  const register = useCallback((element: HTMLDivElement | null) => {
    slot.current = element;
    registerPage(pageNumber, element);
  }, [pageNumber, registerPage]);
  useLayoutEffect(() => {
    if (!active || !slot.current) return;
    const element = slot.current;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      const height = element.getBoundingClientRect().height;
      setMeasured((previous) => previous?.height === height && previous.scale === scale && previous.reading === props.reading ? previous : { height, scale, reading:props.reading });
    };
    if (!props.reading) measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { disposed = true; observer.disconnect(); };
  }, [active, scale, props.reading]);
  const height = Math.max(PDF_HEIGHT * scale, measured ? measured.height * scale / measured.scale : 0);
  const rememberedHeight = props.reading && measured?.reading === props.reading ? measured.height : undefined;
  return <div ref={register} className="pdf-page-slot" data-page={pageNumber} style={{ width: "100%", minHeight: props.reading ? 0 : active ? PDF_HEIGHT * scale : height, contentVisibility: rememberedHeight == null || nearViewport ? undefined : "auto", containIntrinsicBlockSize: rememberedHeight == null ? undefined : `auto ${rememberedHeight}px` }}>
    {active ? <PdfPage {...props} /> : <div className="continuous-page-row" data-page={pageNumber} data-layout-mode={props.layoutMode} aria-hidden="true"><aside className="aligned-cue-rail" /><div className="pdf-page-stage" style={{ width: PDF_WIDTH * scale, height: PDF_HEIGHT * scale }} /></div>}
  </div>;
});

function PdfPage({
  reading,
  pdf,
  pdfjs,
  pageNumber,
  renderEpoch,
  scale,
  markerScale,
  layoutMode,
  compactPdf,
  railConnectorGap,
  tapOnlyMode,
  hoverCapable,
  cues,
  profiles,
  discussionCounts,
  noteVisibility,
  discussions,
  sceneContext,
  sceneBoundaries,
  stickySceneId,
  selectedCueId,
  anchorMode,
  outOfOrderCueIds,
  pendingNote,
  commentText,
  setCommentText,
  onCancelPendingNote,
  onPostPendingNote,
  onSelectCue,
  onOpenCueNotes,
  onOpenScene,
  onAnchorChosen,
  noteMode,
  onNoteTarget,
  onPlaceNote,
  onReplyNote,
  onOpenDiscussion,
  onDismissDiscussion,
  focusedDiscussionId,
  replyingToId,
  replyText,
  setReplyText,
  startReply,
  cancelReply,
  postReply,
  toggleResolved,
  onMoveCue,
  onDeleteCue,
  onToggleCueMode,
  onToggleCueBlackout,
  onEditCueNumber,
  onUnassignCueNumber,
  busyGroups,
}: {
  reading?: ReadingOptions;
  compactPdf: boolean;
  pdf: PDFDocumentProxy;
  pdfjs: PdfJs;
  pageNumber: number;
  renderEpoch: number;
  scale: number;
  markerScale: number;
  layoutMode: "laptop" | "overlap";
  railConnectorGap: number;
  tapOnlyMode: boolean;
  hoverCapable: boolean;
  cues: Cue[];
  profiles: Profile[];
  discussionCounts: Readonly<Record<string, number>>;
  noteVisibility: NoteVisibility;
  discussions: Discussion[];
  sceneContext: SceneRailContext | null;
  sceneBoundaries: SceneRailContext[];
  stickySceneId?: string;
  selectedCueId: string | null;
  anchorMode: boolean;
  outOfOrderCueIds: ReadonlySet<string>;
  pendingNote: PendingNote | null;
  commentText: string;
  setCommentText: (value: string) => void;
  onCancelPendingNote: () => void;
  onPostPendingNote: () => void;
  registerPage: (pageNumber: number, element: HTMLDivElement | null) => void;
  onSelectCue: (id: string) => void;
  onOpenCueNotes: (cueId: string) => void;
  onOpenScene: (sceneId: string) => void;
  onAnchorChosen: (draft: PdfAnchorDraft, anchorType: "line" | "phrase") => void;
  noteMode: boolean;
  onNoteTarget: (target: { type: "cue" | "scene"; id: string }, draft?: PdfAnchorDraft) => void;
  onPlaceNote: (target: { type: "cue" | "scene"; id: string } | null, draft: PdfAnchorDraft) => void;
  onReplyNote: (discussionId: string) => void;
  onOpenDiscussion: (discussionId: string) => void;
  onDismissDiscussion: () => void;
  focusedDiscussionId: string | null;
  replyingToId: string | null;
  replyText: string;
  setReplyText: (value: string) => void;
  startReply: (id: string) => void;
  cancelReply: () => void;
  postReply: (id: string) => void;
  toggleResolved: (discussion: Discussion) => void;
  onMoveCue: (cueId: string) => void;
  onDeleteCue: (cueId: string) => void;
  onToggleCueMode: (cueId: string) => void;
  onToggleCueBlackout: (cueId: string) => void;
  onEditCueNumber: (cueId: string) => void;
  onUnassignCueNumber: (cueId: string) => void;
  busyGroups: ReadonlySet<string>;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const completedRender = useRef<{ pdf: PDFDocumentProxy; scale: number; epoch: number } | null>(null);
  const [renderedPageSize, setRenderedPageSize] = useState<{ width: number; height: number; scale: number } | null>(null);
  const [textRuns, setTextRuns] = useState<TextRun[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [selectionTool, setSelectionTool] = useState<SelectionDraft | null>(null);
  const [hoveredCueId, setHoveredCueId] = useState<string | null>(null);
  const restingCueBoxes = useRef<Record<string, { x:number; y:number; pageWidth:number }>>({});
  const { enter: enterCueHover, leave: leaveCueHover, clear: clearCueHover, activeIds: heldCueIds } = useRailHover(setHoveredCueId, "cue");
  const previousCueHover = useRef(heldCueIds);
  useLayoutEffect(() => {
    const previous = previousCueHover.current;
    previousCueHover.current = heldCueIds;
    if (previous === heldCueIds) return;
    const rows = [...(rowRef.current?.querySelectorAll<HTMLElement>(".aligned-cue-row") ?? [])].filter(row => row.dataset.cueId && previous.has(row.dataset.cueId) !== heldCueIds.has(row.dataset.cueId));
    // Freeze resting measurements before the first frame of either transition.
    // transitionrun fires too late when focus interrupts a closing card.
    rows.forEach(row => { row.dataset.motion = "changing"; });
    // Normalize both sides before paint; waiting for transitionrun would allow
    // a rapid handoff to briefly shrink while several old cues close at once.
    rowRef.current?.dispatchEvent(new Event("rail-hover-motion-change", { bubbles:true }));
    if (layoutMode === "laptop") {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) rows.forEach(row => { delete row.dataset.motion; });
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      rows.forEach(row => {
        if (row.getAnimations().some(animation => ["running", "paused"].includes(animation.playState) && "transitionProperty" in animation && animation.transitionProperty === "min-height")) return;
        delete row.dataset.motion;
      });
      rowRef.current?.dispatchEvent(new Event("rail-layout-settled"));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [heldCueIds, layoutMode]);
  const [railGroupHeights, setRailGroupHeights] = useState<Record<string, number>>({});
  const [restingRailGroupHeights, setRestingRailGroupHeights] = useState<Record<string, number>>({});
  const [connectorStyles, setConnectorStyles] = useState<Record<string, CSSProperties>>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: "script" | "cue" | "scene" | "note"; discussionId?: string; cueId?: string; sceneId?: string; phraseDraft: PdfAnchorDraft; lineDraft: PdfAnchorDraft } | null>(null);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuReturnFocusRef = useRef<HTMLElement | null>(null);
  const selectionReturnFocusRef = useRef<HTMLElement | null>(null);
  const copyStatusTimerRef = useRef<number | null>(null);

  const [readerGeometry, setReaderGeometry] = useState<ReaderGeometry | null>(null);
  const measureReader = useCallback((geometry: ReaderGeometry) => {
    setReaderGeometry(previous => JSON.stringify(previous) === JSON.stringify(geometry) ? previous : geometry);
  }, []);
  const pageSize = useMemo(() => reading ? { width: reading.width, height: readerGeometry?.height ?? 576, scale } : renderedPageSize?.scale === scale
    ? renderedPageSize
    : { width: PDF_WIDTH * scale, height: PDF_HEIGHT * scale }, [readerGeometry, reading, renderedPageSize, scale]);
  const sourceY = useCallback((anchorY: number) => reading && readerGeometry?.sourceYs.length ? readerGeometry.sourceYs.reduce((best, item) => Math.abs(item.source - anchorY) < Math.abs(best.source - anchorY) ? item : best).y : anchorY * pageSize.height, [pageSize.height, readerGeometry, reading]);

  useEffect(() => {
    if (reading || !canvasHostRef.current || !textLayerRef.current) return;
    const initialTextLayer = textLayerRef.current;
    const previous = completedRender.current;
    if (previous?.pdf === pdf && previous.scale === scale && previous.epoch === renderEpoch && canvasHostRef.current.firstElementChild) return;
    completedRender.current = null;
    let cancelled = false;
    let cancelRender: (() => void) | null = null;
    let cancelText: (() => void) | null = null;
    let pendingCanvas: HTMLCanvasElement | null = null;
    setStatus("loading");
    setSelectionTool(null);
    const render = async () => {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      if (cancelled || !canvasHostRef.current || !textLayerRef.current) return;
      setRenderedPageSize({ width: viewport.width, height: viewport.height, scale });
      // Never progressively paint or clear the visible page. Finish a detached
      // bitmap first, then publish it atomically so Safari's scrolling tiles
      // cannot retain an interrupted render. The last complete bitmap stays
      // visible while a zoom or resume render is underway.
      const canvas = document.createElement("canvas");
      pendingCanvas = canvas;
      canvas.setAttribute("aria-label", `Script page ${scriptPageNumber(pageNumber)}`);
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      const textContentPromise = page.getTextContent();
      const renderTask = page.render({ canvas, viewport, transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0] });
      cancelRender = () => renderTask.cancel();
      const [, textContent] = await Promise.all([renderTask.promise, textContentPromise]);
      if (cancelled || !textLayerRef.current) return;
      const container = initialTextLayer;
      if (!container.isConnected) return;
      container.replaceChildren();
      container.style.setProperty("--scale-factor", String(scale));
      const layer = new pdfjs.TextLayer({ textContentSource: textContent, container, viewport });
      cancelText = () => layer.cancel();
      await layer.render();
      if (cancelled || !canvasHostRef.current) return;
      const oldCanvas = canvasHostRef.current.firstElementChild as HTMLCanvasElement | null;
      canvasHostRef.current.replaceChildren(canvas);
      pendingCanvas = null;
      if (oldCanvas) { oldCanvas.width = 0; oldCanvas.height = 0; }
      const pageBox = pageRef.current?.getBoundingClientRect();
      if (pageBox) {
        setTextRuns(layer.textDivs.map((element, index) => {
          element.dataset.pdfTextIndex = String(index);
          const rect = element.getBoundingClientRect();
          return { text: layer.textContentItemsStr[index] ?? "", x: rect.left - pageBox.left, y: rect.top - pageBox.top, width: rect.width, height: rect.height };
        }));
      }
      completedRender.current = { pdf, scale, epoch: renderEpoch };
      setStatus("ready");
    };
    render().catch(() => { if (!cancelled) setStatus("error"); }).finally(() => {
      // Release cancelled, detached backing stores instead of retaining GPU
      // memory through rapid scroll reversals.
      if (pendingCanvas) { pendingCanvas.width = 0; pendingCanvas.height = 0; }
    });
    return () => { cancelled = true; cancelRender?.(); cancelText?.(); };
  }, [pageNumber, pdf, pdfjs, reading, renderAttempt, renderEpoch, scale]);

  const resolvedCues = useMemo(() => {
    if (reading) {
      const sourcePage = reading.document.pages.find(page => page.pdfPage === pageNumber);
      const anchored = cues.map(cue => {
        const source = resolveCueSource(reading.document, cue);
        return { ...cue, anchorY: source && sourcePage ? source.line.bbox[1] / sourcePage.height : cue.anchorY,
          anchorX: source && sourcePage ? source.line.words[source.word].bbox[0] / sourcePage.width : cue.anchorX,
          enclosingLine: source?.line.text ?? cue.enclosingLine };
      });
      return orderCuePlacements(anchored).map(anchor => ({ cue:cues.find(cue => cue.id === anchor.id)!, sortPosition:anchor.anchorY ?? 0,
        ...(readerGeometry?.cues[anchor.id] ?? { x:48, y:35 }) }));
    }
    const lines: Array<{ text: string; runs: TextRun[]; y: number }> = [];
    [...textRuns].sort((a, b) => a.y - b.y || a.x - b.x).forEach((run) => {
      const line = lines.find((item) => Math.abs(item.y - run.y) < Math.max(4, run.height * .45));
      if (line) {
        line.runs.push(run);
        line.runs.sort((a, b) => a.x - b.x);
        line.text = line.runs.map((item) => item.text).join(" ");
      } else {
        lines.push({ text: run.text, runs: [run], y: run.y });
      }
    });
    const resolved = cues.map((cue) => {
      if (cue.anchorY != null) {
        const savedY = cue.anchorY * pageSize.height;
        const nearestLine = lines.length > 0 ? [...lines].sort((a, b) => Math.abs(a.y - savedY) - Math.abs(b.y - savedY))[0] : undefined;
        const x = cue.anchorType === "line" ? nearestLine?.runs[0]?.x ?? (cue.anchorX ?? 0.08) * pageSize.width : (cue.anchorX ?? 0.08) * pageSize.width;
        return { cue, x, y: nearestLine?.y ?? savedY };
      }
      const target = normalizeText(cue.selectedText);
      const targetWords = [...new Set(target.split(" ").filter(Boolean))];
      const candidates = lines.map((line, index) => {
        const windowLines = lines.slice(index, index + 3);
        const words = new Set(normalizeText(windowLines.map((item) => item.text).join(" ")).split(" "));
        const score = targetWords.filter((word) => words.has(word)).length / Math.max(1, targetWords.length);
        return { line, windowLines, score };
      }).sort((a, b) => b.score - a.score);
      const match = candidates[0]?.score >= (targetWords.length === 1 ? 1 : .6) ? candidates[0] : undefined;
      const line = match?.windowLines.sort((a, b) => {
        const aWords = new Set(normalizeText(a.text).split(" "));
        const bWords = new Set(normalizeText(b.text).split(" "));
        return targetWords.filter((word) => bWords.has(word)).length - targetWords.filter((word) => aWords.has(word)).length;
      })[0];
      const firstWord = targetWords.find((word) => line?.runs.some((item) => normalizeText(item.text).includes(word)));
      const run = line?.runs.find((item) => firstWord && normalizeText(item.text).includes(firstWord)) ?? line?.runs[0];
      return { cue, x: run?.x ?? pageSize.width * 0.08, y: line?.y ?? pageSize.height * 0.12 };
    });
    const order = new Map(orderCuePlacements(resolved.map((entry) => ({
      ...entry.cue,
      anchorX: entry.x / Math.max(1, pageSize.width),
      anchorY: entry.y / Math.max(1, pageSize.height),
    }))).map((cue, index) => [cue.id, index]));
    return resolved.sort((left, right) => (order.get(left.cue.id) ?? 0) - (order.get(right.cue.id) ?? 0)).map(entry => ({...entry, sortPosition:entry.y / Math.max(1,pageSize.height)}));
  }, [cues, pageNumber, pageSize, readerGeometry, reading, textRuns]);

  const scriptNotes = useMemo(() => discussions.filter((discussion) => discussionTargetType(discussion) === "script"), [discussions]);
  const cueNotes = useMemo(() => discussions.filter((discussion) => discussionTargetType(discussion) === "cue" && discussion.cueId), [discussions]);
  const sceneNotes = useMemo(() => discussions.filter((discussion) => discussionTargetType(discussion) === "scene" && discussion.sceneId), [discussions]);
  const visibleNote = useCallback((discussion: Discussion) => noteVisibility !== "none" && (noteVisibility === "all" || !discussion.resolved), [noteVisibility]);

  useEffect(() => {
    const root = rowRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const groups = [...root.querySelectorAll<HTMLElement>("[data-rail-group-id]")];
    if (!groups.length) return;
    const measure = () => {
      if (reading && !nearReadingPage(root)) return;
      const next: Record<string, number> = {};
      const expanding = new Set<string>();
      root.querySelectorAll<HTMLElement>("[data-rail-group-id]").forEach((element) => {
        const id = element.dataset.railGroupId;
        if (id) {
          next[id] = element.getBoundingClientRect().height;
          if (element.querySelector('.discussion-card.expanded,.discussion-card[data-motion="changing"],.aligned-cue-row[data-motion="changing"],.rail-cue-slot[data-motion="changing"],.aligned-cue-row.hover-linked,.aligned-cue-row:hover,.aligned-cue-row:focus-visible,.cue-rail-actions:focus-within')) expanding.add(id);
        }
      });
      setRailGroupHeights((current) => {
        const keys = Object.keys(next);
        return keys.length === Object.keys(current).length && keys.every((key) => Math.abs((current[key] ?? 0) - next[key]) < .5) ? current : next;
      });
      // Balance cards at their resting heights. Expansion then grows down from
      // that position instead of rebalancing a hovered card under the pointer.
      setRestingRailGroupHeights((current) => {
        const resting = Object.fromEntries(Object.entries(next).map(([id, height]) => [id, expanding.has(id) ? current[id] ?? height : height]));
        const keys = Object.keys(resting);
        return keys.length === Object.keys(current).length && keys.every((key) => Math.abs((current[key] ?? 0) - resting[key]) < .5) ? current : resting;
      });
    };
    const observer = new ResizeObserver(() => {
      // Keep downstream positions in the same paint as animated slot heights.
      // Deferring this commit made the rail lag a frame, then catch up in jumps.
      // Initial and idle deliveries still batch across the complete script.
      if (root.querySelector('.rail-cue-slot[data-motion="changing"],.rail-note-slot[data-motion="changing"]')) flushSync(measure);
      else measure();
    });
    const cancelFrames = new Set<number>();
    const cueTransition = (event: Event) => {
      const transition = event as TransitionEvent;
      const cue = transition.target as HTMLElement;
      if (!cue.matches(".aligned-cue-row") || transition.propertyName !== "min-height") return;
      if (transition.type === "transitionrun") cue.dataset.motion = "changing";
      else if (transition.type === "transitionend") { delete cue.dataset.motion; measure(); }
      else {
        const frame = window.requestAnimationFrame(() => {
          cancelFrames.delete(frame);
          if (!root.contains(cue) || cue.getAnimations().some(animation => ["running", "paused"].includes(animation.playState) && "transitionProperty" in animation && animation.transitionProperty === "min-height")) return;
          delete cue.dataset.motion;
          measure();
        });
        cancelFrames.add(frame);
      }
    };
    const settled = (event: Event) => {
      const slot = event.target as HTMLElement;
      if (slot.matches(".rail-cue-slot") && slot.dataset.motion !== "changing") {
        const row = slot.querySelector<HTMLElement>(".aligned-cue-row");
        if (row) delete row.dataset.motion;
      }
      measure();
    };
    root.addEventListener("rail-layout-settled", settled);
    for (const name of ["transitionrun", "transitionend", "transitioncancel"]) root.addEventListener(name, cueTransition);
    const observeNearby = () => {
      const near = !reading || nearReadingPage(root);
      groups.forEach(element => near ? observer.observe(element) : observer.unobserve(element));
    };
    const visibility = reading ? new IntersectionObserver(observeNearby, { root:root.closest(".pdf-frame"), rootMargin:"1200px 0px" }) : null;
    visibility?.observe(root.closest(".pdf-page-slot") ?? root);
    observeNearby();
    // ResizeObserver supplies initial sizes in one layout batch.
    return () => {
      observer.disconnect();
      visibility?.disconnect();
      root.removeEventListener("rail-layout-settled", settled);
      for (const name of ["transitionrun", "transitionend", "transitioncancel"]) root.removeEventListener(name, cueTransition);
      for (const frame of cancelFrames) window.cancelAnimationFrame(frame);
    };
  }, [commentText, cueNotes, cues, focusedDiscussionId, pendingNote, sceneBoundaries, sceneNotes, scriptNotes, stickySceneId, noteVisibility, reading]);

  const expandedRailCueId = hoveredCueId ?? (contextMenu?.target === "cue" ? contextMenu.cueId ?? null : null);
  const baseRailLayout = useMemo(() => layoutRailItems([
    ...resolvedCues.map((entry, index) => ({
      id: `cue:${entry.cue.id}`,
      kind: "cue" as const,
      desiredTop: entry.y - 14,
      sortPosition: entry.sortPosition,
      height: compactPdf ? (discussionCounts[entry.cue.id] > 0 ? 92 : 44) : layoutMode === "overlap" ? 30 : restingRailGroupHeights[`cue:${entry.cue.id}`] ?? 48 + cueNotes.filter((note) => note.cueId === entry.cue.id && visibleNote(note)).length * 64,
      order: index,
    })),
    ...(compactPdf ? [] : sceneBoundaries).map((boundary) => ({
      id: `scene:${boundary.id}`,
      kind: "scene" as const,
      desiredTop: sourceY(boundary.startY),
      sortPosition: boundary.startY,
      height: restingRailGroupHeights[`scene:${boundary.id}`] ?? 128,
    })),
  ], reading && pageNumber === FIRST_SCRIPT_PDF_PAGE ? 128 : 35, 5), [compactPdf, discussionCounts, cueNotes, layoutMode, pageNumber, reading, restingRailGroupHeights, resolvedCues, sceneBoundaries, sourceY, visibleNote]);
  const expandedRailCueHeight = expandedRailCueId ? Math.max(54, railGroupHeights[`cue:${expandedRailCueId}`] ?? 0) : 54;
  const railLayout = useMemo(() => {
    if (layoutMode === "overlap") return makeRoomBelowPinnedItem(baseRailLayout, expandedRailCueId ? `cue:${expandedRailCueId}` : null, expandedRailCueHeight, 8, 5);
    let bottom = 0;
    return baseRailLayout.map((item) => {
      const height = railGroupHeights[item.id] ?? item.height;
      const top = Math.max(item.top, bottom);
      bottom = top + height + 5;
      return { ...item, top, height };
    });
  }, [baseRailLayout, expandedRailCueHeight, expandedRailCueId, layoutMode, railGroupHeights]);
  const tightlyPackedCueIds = useMemo(() => new Set(baseRailLayout.flatMap((item, index) => {
    const next = baseRailLayout[index + 1];
    return item.kind === "cue" && next?.kind === "cue" && next.top - (item.top + item.height) <= 5.5 ? [item.id] : [];
  })), [baseRailLayout]);
  const railTops = useMemo(() => Object.fromEntries(railLayout.map((item) => [item.id, item.top])), [railLayout]);
  const railCues = useMemo(() => resolvedCues.map((entry) => ({
    ...entry,
    displayY: railTops[`cue:${entry.cue.id}`] ?? 35,
    rowHeight: compactPdf ? (discussionCounts[entry.cue.id] > 0 ? 92 : 44) : layoutMode === "overlap"
      ? expandedRailCueId === entry.cue.id
        ? Math.max(54, railGroupHeights[`cue:${entry.cue.id}`] ?? 0)
        : 30
      : railGroupHeights[`cue:${entry.cue.id}`] ?? 48,
    hasTightNext: tightlyPackedCueIds.has(`cue:${entry.cue.id}`),
    zone: 0,
  })), [compactPdf, discussionCounts, expandedRailCueId, layoutMode, railGroupHeights, railTops, resolvedCues, tightlyPackedCueIds]);

  useEffect(() => {
    const root = rowRef.current;
    const page = pageRef.current;
    if (!root || !page || typeof ResizeObserver === "undefined" || reading && layoutMode === "overlap" || !railCues.some(({cue}) => cue.anchorType === "line")) return;
    let frame = 0;
    const measure = () => {
      if (reading && !nearReadingPage(root)) return;
      const next: Record<string, CSSProperties> = {};
      const pageBox = page.getBoundingClientRect();
      railCues.filter(({ cue }) => cue.anchorType === "line").forEach(({ cue }) => {
        const group = root.querySelector<HTMLElement>(`[data-rail-group-id="cue:${cue.id}"]`);
        const cueRow = group?.querySelector<HTMLElement>(".aligned-cue-row");
        const markerHit = [...root.querySelectorAll<HTMLElement>(".script-anchor-hit")].find((element) => element.dataset.cueId === cue.id);
        if (!group || !cueRow || !markerHit) return;
        const cueBox = cueRow.getBoundingClientRect();
        const markerBox = markerHit.getBoundingClientRect();
        if (!cueBox.width || !cueBox.height) return;
        const enlarged = cueRow.matches(":hover,:focus-visible") || cueRow.classList.contains("hover-linked") || !!group.querySelector(".cue-rail-actions:focus-within");
        const resting = { x:cueBox.right - pageBox.left, y:cueBox.top + (layoutMode === "laptop" ? 30 : cueBox.height) / 2 - pageBox.top, pageWidth:pageBox.width };
        if (!enlarged && cueRow.dataset.motion !== "changing" || !restingCueBoxes.current[cue.id] || Math.abs(restingCueBoxes.current[cue.id].pageWidth - pageBox.width) > .5) restingCueBoxes.current[cue.id] = resting;
        const { x:startX, y:startY } = restingCueBoxes.current[cue.id];
        const endX = markerBox.left + markerBox.width / 2 - pageBox.left;
        const endY = markerBox.top + markerBox.height / 2 - pageBox.top;
        const deltaX = endX - startX;
        const deltaY = endY - startY;
        next[cue.id] = {
          left: startX,
          top: startY,
          width: Math.max(0, Math.hypot(deltaX, deltaY)),
          transform: `rotate(${Math.atan2(deltaY, deltaX) * 180 / Math.PI}deg)`,
        };
      });
      setConnectorStyles((current) => {
        const currentKeys = Object.keys(current);
        const nextKeys = Object.keys(next);
        return currentKeys.length === nextKeys.length && nextKeys.every((key) => {
          const oldStyle = current[key];
          const newStyle = next[key];
          return oldStyle?.left === newStyle.left && oldStyle?.top === newStyle.top && oldStyle?.width === newStyle.width && oldStyle?.transform === newStyle.transform;
        }) ? current : next;
      });
    };
    const schedule = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const observer = new ResizeObserver(schedule);
    const targets = [root, page, ...root.querySelectorAll<HTMLElement>(".aligned-cue-row,.script-anchor-hit")];
    const observeNearby = () => {
      const near = !reading || nearReadingPage(root);
      targets.forEach(element => near ? observer.observe(element) : observer.unobserve(element));
      if (near) schedule();
    };
    const visibility = reading ? new IntersectionObserver(observeNearby, { root:root.closest(".pdf-frame"), rootMargin:"1200px 0px" }) : null;
    visibility?.observe(root.closest(".pdf-page-slot") ?? root);
    observeNearby();
    window.addEventListener("resize", schedule);
    let movementFrame = 0;
    if (layoutMode === "overlap" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const movementEndsAt = performance.now() + 350;
      const followMovement = () => {
        measure();
        if (performance.now() < movementEndsAt) movementFrame = window.requestAnimationFrame(followMovement);
      };
      movementFrame = window.requestAnimationFrame(followMovement);
    }
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (movementFrame) window.cancelAnimationFrame(movementFrame);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      visibility?.disconnect();
    };
  }, [layoutMode, markerScale, pageSize.height, pageSize.width, pendingNote, railCues, railGroupHeights, reading, status]);

  const captureSelection = useCallback((event: MouseEvent) => {
    if ((event.target as HTMLElement).closest(".reader-cue-marker")) return;
    window.setTimeout(() => {
      if (!anchorMode && !noteMode) { setSelectionTool(null); return; }
      const selection = window.getSelection();
      const pageBox = pageRef.current?.getBoundingClientRect();
      const textLayer = textLayerRef.current;
      if (!selection || !pageBox || !textLayer) {
        setSelectionTool(null);
        return;
      }
      const hasSelection = !selection.isCollapsed && selection.rangeCount > 0 && textLayer.contains(selection.anchorNode);
      const clickedText = anchorMode && textLayer.contains(event.target as Node) ? wordRangeAtPoint(event.clientX, event.clientY, textLayer) : null;
      const range = hasSelection ? selection.getRangeAt(0) : clickedText;
      if (!range) {
        setSelectionTool(null);
        return;
      }
      const rawSelectedText = range.toString().replace(/\s+/g, " ").trim();
      if (!rawSelectedText) return;
      const rect = range.getBoundingClientRect();
      const y = rect.top - pageBox.top;
      if (reading) {
        const draft = readingDraftAtPoint(reading, textLayer, event.clientX, event.clientY, hasSelection);
        if (draft) setSelectionTool({ ...draft, left: Math.max(8, Math.min(pageBox.width - 255, rect.left - pageBox.left)), top: Math.max(8, y - 48) });
        return;
      }
      const lineRuns = textRuns.filter((run) => Math.abs((run.y + run.height / 2) - (y + rect.height / 2)) < Math.max(5, rect.height * 0.65)).sort((a, b) => a.x - b.x);
      const enclosingLine = normalizeAnchorLine(lineRuns.map((run) => run.text).join(" ")) || rawSelectedText;
      selectionReturnFocusRef.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : pageRef.current;
      setSelectionTool({
        page: pageNumber,
        selectedText: snapSelectionToWords(rawSelectedText, enclosingLine),
        enclosingLine,
        anchorX: Math.max(0, Math.min(1, (rect.left - pageBox.left) / pageBox.width)),
        anchorY: Math.max(0, Math.min(1, y / pageBox.height)),
        lineAnchorX: Math.max(0, Math.min(1, (lineRuns[0]?.x ?? rect.left - pageBox.left) / pageBox.width)),
        lineAnchorY: Math.max(0, Math.min(1, (lineRuns[0]?.y ?? y) / pageBox.height)),
        left: Math.max(8, Math.min(pageBox.width - 255, rect.left - pageBox.left)),
        top: Math.max(8, y - 48),
      });
    }, 0);
  }, [anchorMode, noteMode, pageNumber, reading, textRuns]);

  useEffect(() => {
    const pageElement = pageRef.current;
    if (!pageElement) return;
    pageElement.addEventListener("mouseup", captureSelection);
    return () => pageElement.removeEventListener("mouseup", captureSelection);
  }, [captureSelection]);

  const chooseAnchor = (type: "line" | "phrase") => {
    if (!selectionTool) return;
    const draft: PdfAnchorDraft = {
      page: selectionTool.page,
      selectedText: type === "line" ? selectionTool.enclosingLine : selectionTool.selectedText,
      enclosingLine: selectionTool.enclosingLine,
      anchorX: type === "line" ? selectionTool.lineAnchorX : selectionTool.anchorX,
      anchorY: selectionTool.lineAnchorY,
    };
    onAnchorChosen(lineAlignedAnchor(draft), type);
    window.getSelection()?.removeAllRanges();
    setSelectionTool(null);
    window.requestAnimationFrame(() => selectionReturnFocusRef.current?.focus());
    selectionReturnFocusRef.current = null;
  };

  const positionedScriptNotes = useMemo(() => {
    const minHeight = 30;
    const gap = 4;
    const pageInset = 4;
    const pendingScript = pendingNote?.kind === "script" && pendingNote.anchor.page === pageNumber ? pendingNote : null;
    const entries = [
      ...scriptNotes.filter(visibleNote).map((discussion) => ({ key: `discussion:${discussion.id}`, discussion, pending: undefined, anchorY: discussion.anchorY ?? .12 })),
      ...(pendingScript ? [{ key: "pending", discussion: undefined, pending: pendingScript, anchorY: pendingScript.anchor.anchorY }] : []),
    ].sort((left, right) => left.anchorY - right.anchorY || left.key.localeCompare(right.key));
    const positioned = entries.reduce<Array<{ key: string; discussion?: Discussion; pending?: PendingNote; top: number; height: number }>>((result, entry) => {
      const height = restingRailGroupHeights[`script:${entry.discussion?.id ?? "pending"}`] ?? (entry.pending ? 128 : minHeight);
      const ideal = Math.max(pageInset, sourceY(entry.anchorY));
      const previous = result.at(-1);
      const previousBottom = previous ? previous.top + previous.height + gap : pageInset;
      return [...result, { key: entry.key, discussion: entry.discussion, pending: entry.pending, top: Math.max(ideal, previousBottom), height }];
    }, []);
    const last = positioned.at(-1);
    if (!last) return positioned;
    const overflow = Math.max(0, last.top + last.height + pageInset - pageSize.height);
    const availableShift = Math.max(0, positioned[0].top - pageInset);
    const shift = Math.min(overflow, availableShift);
    let bottom = pageInset;
    return positioned.map((entry) => {
      const height = railGroupHeights[`script:${entry.discussion?.id ?? "pending"}`] ?? entry.height;
      const top = Math.max(entry.top - shift, bottom);
      bottom = top + height + gap;
      return { ...entry, top, height };
    });
  }, [pageNumber, pageSize.height, pendingNote, railGroupHeights, restingRailGroupHeights, scriptNotes, sourceY, visibleNote]);
  const cueContentHeight = railCues.reduce((extent, cue) => Math.max(extent, cue.displayY + cue.rowHeight + 4), pageSize.height);
  const sceneContentHeight = sceneBoundaries.reduce((extent, scene) => Math.max(extent, (railTops[`scene:${scene.id}`] ?? scene.startY * pageSize.height) + (railGroupHeights[`scene:${scene.id}`] ?? 128) + 4), pageSize.height);
  const noteContentHeight = positionedScriptNotes.reduce((extent, note) => Math.max(extent, note.top + note.height + 4), pageSize.height);
  const pageContentHeight = reading && layoutMode === "overlap" ? pageSize.height : Math.max(pageSize.height, cueContentHeight, sceneContentHeight, noteContentHeight);
  const draftAtPoint = useCallback((clientX: number, clientY: number) => {
    if (reading && pageRef.current) {
      const draft = readingDraftAtPoint(reading, pageRef.current, clientX, clientY, true);
      if (draft) return { phraseDraft: draft, lineDraft: { ...draft, selectedText: draft.enclosingLine, anchorX: draft.lineAnchorX } };
    }
    const pageBox = pageRef.current?.getBoundingClientRect();
    const textLayer = textLayerRef.current;
    const localX = pageBox ? Math.max(0, Math.min(pageBox.width, clientX - pageBox.left)) : pageSize.width * .5;
    const localY = pageBox ? Math.max(0, Math.min(pageBox.height, clientY - pageBox.top)) : pageSize.height * .12;
    const nearestLine = [...textRuns].sort((left, right) => Math.abs(left.y + left.height / 2 - localY) - Math.abs(right.y + right.height / 2 - localY))[0];
    const lineRuns = textRuns.filter((run) => nearestLine && Math.abs(run.y + run.height / 2 - (nearestLine.y + nearestLine.height / 2)) < Math.max(5, nearestLine.height * .65)).sort((left, right) => left.x - right.x);
    const lineText = normalizeAnchorLine(lineRuns.map((run) => run.text).join(" ")) || normalizeAnchorLine(nearestLine?.text ?? "") || "Script line";
    const selection = window.getSelection();
    const selectionRange = selection && !selection.isCollapsed && selection.rangeCount > 0 && textLayer?.contains(selection.anchorNode) ? selection.getRangeAt(0) : null;
    const selectionRect = selectionRange?.getBoundingClientRect();
    const clickIsInSelection = !!selectionRect && clientX >= selectionRect.left && clientX <= selectionRect.right && clientY >= selectionRect.top && clientY <= selectionRect.bottom;
    const wordRange = textLayer ? wordRangeAtPoint(clientX, clientY, textLayer) : null;
    const phraseRange = clickIsInSelection ? selectionRange : wordRange;
    const phraseRect = phraseRange?.getBoundingClientRect();
    const clickedRun = lineRuns.find((run) => localX >= run.x && localX <= run.x + run.width) ?? nearestLine;
    const runText = clickedRun?.text ?? "";
    let runIndex = Math.min(Math.max(0, Math.floor((localX - (clickedRun?.x ?? localX)) / Math.max(1, clickedRun?.width ?? 1) * runText.length)), Math.max(0, runText.length - 1));
    while (runIndex < runText.length && !isWordCharacter(runText[runIndex])) runIndex += 1;
    let runStart = runIndex;
    let runEnd = runIndex;
    while (runStart > 0 && isWordCharacter(runText[runStart - 1])) runStart -= 1;
    while (runEnd < runText.length && isWordCharacter(runText[runEnd])) runEnd += 1;
    const fallbackWord = runText.slice(runStart, runEnd);
    const phraseText = phraseRange?.toString().replace(/\s+/g, " ").trim() || fallbackWord || lineText;
    const anchorY = Math.max(0, Math.min(1, (nearestLine?.y ?? localY) / Math.max(1, pageSize.height)));
    const lineAnchorX = Math.max(0, Math.min(1, (lineRuns[0]?.x ?? localX) / Math.max(1, pageSize.width)));
    const phraseDraft: PdfAnchorDraft = { page: pageNumber, selectedText: snapSelectionToWords(phraseText, lineText), enclosingLine: lineText, anchorX: Math.max(0, Math.min(1, ((phraseRect?.left ?? ((pageBox?.left ?? 0) + (clickedRun?.x ?? localX))) - (pageBox?.left ?? 0)) / Math.max(1, pageSize.width))), anchorY, lineAnchorX, lineAnchorY: anchorY };
    const lineDraft: PdfAnchorDraft = { page: pageNumber, selectedText: lineText, enclosingLine: lineText, anchorX: lineAnchorX, anchorY, lineAnchorX, lineAnchorY: anchorY };
    return { phraseDraft, lineDraft };
  }, [pageNumber, pageSize.height, pageSize.width, reading, textRuns]);

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.shiftKey) return;
    event.preventDefault();
    const element = (event.target as HTMLElement).closest(".discussion-card,.script-anchor-hit,.script-anchor-marker,.aligned-cue-row,.scene-boundary-card");
    const discussionId = element?.getAttribute("data-discussion-id") ?? undefined;
    const cueId = element?.getAttribute("data-cue-id") ?? undefined;
    const sceneId = element?.getAttribute("data-scene-id") ?? undefined;
    const target = discussionId ? "note" : sceneId ? "scene" : cueId ? "cue" : "script";
    const { phraseDraft, lineDraft } = draftAtPoint(event.clientX, event.clientY);
    contextMenuReturnFocusRef.current = event.target instanceof HTMLElement ? event.target : null;
    setContextMenu({ x: event.clientX, y: event.clientY, target, discussionId, cueId, sceneId, phraseDraft, lineDraft });
  }, [draftAtPoint]);

  const menuPosition = (element: HTMLElement) => {
    const bounds = element.getBoundingClientRect();
    return { x: Math.max(4, Math.min(window.innerWidth - 166, bounds.right + 4)), y: Math.max(4, Math.min(window.innerHeight - 340, bounds.top)) };
  };
  const openCueMenu = (event: React.MouseEvent<HTMLButtonElement>, cue: Cue) => {
    event.preventDefault();
    event.stopPropagation();
    contextMenuReturnFocusRef.current = event.currentTarget;
    const position = menuPosition(event.currentTarget);
    const phraseDraft: PdfAnchorDraft = { page: cue.page, selectedText: cue.selectedText, enclosingLine: cue.enclosingLine, anchorX: cue.anchorX ?? .08, anchorY: cue.anchorY ?? .12 };
    enterCueHover(cue.id);
    setContextMenu({ ...position, target: "cue", cueId: cue.id, phraseDraft, lineDraft: phraseDraft });
  };
  const openCueNumberEditor = (cue: Cue) => {
    setContextMenu(null);
    onEditCueNumber(cue.id);
  };

  useEffect(() => {
    if (!contextMenu) return;
    const focusFrame = window.requestAnimationFrame(() => contextMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    const close = () => setContextMenu(null);
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      contextMenuReturnFocusRef.current?.focus();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", keydown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", keydown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (contextMenu) return;
    const dismissSelection = (event: PointerEvent) => {
      if (rowRef.current?.contains(event.target as Node)) return;
      setSelectionTool(null);
      window.getSelection()?.removeAllRanges();
      window.requestAnimationFrame(() => selectionReturnFocusRef.current?.focus());
      selectionReturnFocusRef.current = null;
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!selectionTool) return;
      event.preventDefault();
      setSelectionTool(null);
      window.getSelection()?.removeAllRanges();
      window.requestAnimationFrame(() => selectionReturnFocusRef.current?.focus());
      selectionReturnFocusRef.current = null;
    };
    document.addEventListener("pointerdown", dismissSelection);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissSelection);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [contextMenu, selectionTool]);

  useEffect(() => () => {
    if (copyStatusTimerRef.current !== null) window.clearTimeout(copyStatusTimerRef.current);
  }, []);

  const copyText = async (value: string) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const input = document.createElement("textarea");
        input.value = value;
        input.setAttribute("readonly", "");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        const copied = document.execCommand("copy");
        input.remove();
        if (!copied) throw new Error("Copy unavailable");
      }
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
    if (copyStatusTimerRef.current !== null) window.clearTimeout(copyStatusTimerRef.current);
    copyStatusTimerRef.current = window.setTimeout(() => setCopyStatus(null), 2400);
  };

  useEffect(() => {
    if (contextMenu) return;
    const frame = window.requestAnimationFrame(() => {
      const hovered = rowRef.current?.querySelector<HTMLElement>(".aligned-cue-row:hover,.script-anchor-hit:hover,.reader-cue-note-marker:hover");
      if (hovered?.dataset.cueId) enterCueHover(hovered.dataset.cueId);
      else clearCueHover();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contextMenu, enterCueHover, clearCueHover]);

  const handlePageClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!noteMode) return;
    const target = event.target as HTMLElement;
    if (target.closest(".script-anchor-hit,.script-anchor-marker,.script-note-marker,.selection-tool")) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && textLayerRef.current?.contains(selection.anchorNode)) return;
    onPlaceNote(null, draftAtPoint(event.clientX, event.clientY).phraseDraft);
  }, [draftAtPoint, noteMode, onPlaceNote]);

  const handlePageKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((!noteMode && !anchorMode) || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const { phraseDraft, lineDraft } = draftAtPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    if (noteMode) {
      onPlaceNote(null, phraseDraft);
      return;
    }
    setSelectionTool({
      ...phraseDraft,
      lineAnchorX: lineDraft.anchorX ?? phraseDraft.anchorX ?? .08,
      lineAnchorY: lineDraft.anchorY ?? phraseDraft.anchorY ?? .12,
      left: Math.max(8, bounds.width / 2 - 120),
      top: Math.max(8, bounds.height / 2 - 48),
    });
    window.requestAnimationFrame(() => pageRef.current?.querySelector<HTMLButtonElement>(".selection-tool button")?.focus());
  }, [anchorMode, draftAtPoint, noteMode, onPlaceNote]);

  return <div className="continuous-page-row" ref={rowRef} data-page={pageNumber} data-layout-mode={layoutMode} style={{ minHeight: pageContentHeight }} onContextMenu={handleContextMenu}>
    <aside className={`aligned-cue-rail ${sceneContext ? "has-scene" : ""}`} aria-label={`Cues on page ${scriptPageNumber(pageNumber)}`} style={{ height: pageSize.height }}>
      <div className="aligned-rail-context">
        {!reading && <div className="aligned-rail-label"><span>{cues.length} {cues.length === 1 ? "cue" : "cues"}</span></div>}
      </div>
      {sceneBoundaries.map((boundary) => <div className="rail-scene-group" data-rail-group-id={`scene:${boundary.id}`} key={boundary.id} style={{ top: railTops[`scene:${boundary.id}`] ?? boundary.startY * pageSize.height }}>{boundary.firstSceneId !== stickySceneId && <SceneRailCard boundary scene={boundary} onClick={() => noteMode ? onNoteTarget({ type: "scene", id: boundary.firstSceneId }, { page: pageNumber, selectedText: "", enclosingLine: boundary.name, anchorX: .05, anchorY: boundary.startY }) : onOpenScene(boundary.firstSceneId)} />}{sceneNotes.filter((note) => layoutMode === "laptop" && note.sceneId === boundary.firstSceneId && visibleNote(note)).map((note) => <DiscussionCard key={note.id} surface="rail" discussion={note} profiles={profiles} focused={focusedDiscussionId === note.id} contextPinned={contextMenu?.discussionId === note.id} busy={busyGroups.has(`discussion:${note.id}`)} onOpen={onOpenDiscussion} onDismiss={onDismissDiscussion} onStartReply={startReply} onCancelReply={cancelReply} onPostReply={postReply} onToggleResolved={toggleResolved} replyingToId={replyingToId} replyText={replyText} setReplyText={setReplyText} />)}</div>)}
      {/* Gap bridges keep cue targets continuous; notes hand off independently. */}
      {railCues.map(({ cue, displayY, hasTightNext, zone }) => { const contextPinned = contextMenu?.cueId === cue.id && (!tapOnlyMode || contextMenu.target === "cue"); const noteCount = discussionCounts[cue.id] ?? 0; return <div className="rail-cue-group" data-rail-group-id={`cue:${cue.id}`} data-tight-next={hasTightNext || undefined} key={cue.id} style={{ top: displayY }} onPointerEnter={(event) => { if (isHoverPointer(event) && ((event.target as Element).closest(".aligned-cue-row,.cue-rail-actions") || event.clientY >= event.currentTarget.getBoundingClientRect().bottom)) enterCueHover(cue.id); }} onPointerLeave={(event) => { if ((hoverCapable || event.pointerType === "pen") && !contextPinned && !event.currentTarget.querySelector(".cue-rail-actions:focus-within")) leaveCueHover(cue.id); }}><div className="rail-cue-slot"><div className="rail-cue-card"><button data-cue-id={cue.id} data-placement-zone={zone} aria-label={cueCardAriaLabel(cue)} title={cueCardAriaLabel(cue)} className={`aligned-cue-row ${cue.mode} ${cue.blackout ? "blackout" : ""} ${outOfOrderCueIds.has(cue.id) ? "out-of-order" : ""} ${cue.anchorType === "line" ? "line-anchor" : "phrase-anchor"} ${cue.id === selectedCueId ? "active" : ""} ${(!tapOnlyMode && heldCueIds.has(cue.id)) || contextPinned ? "hover-linked" : ""}`} onPointerEnter={event => { if (isHoverPointer(event)) enterCueHover(cue.id); }} onPointerMove={event=>{if(isHoverPointer(event) && !heldCueIds.has(cue.id))enterCueHover(cue.id);}} onPointerLeave={(event) => { if ((hoverCapable || event.pointerType === "pen") && !contextPinned && !event.currentTarget.matches(":focus-visible") && !event.currentTarget.closest(".rail-cue-group")?.contains(event.relatedTarget as Node | null)) leaveCueHover(cue.id); }} onFocus={() => { if (!tapOnlyMode) enterCueHover(cue.id); }} onBlur={(event) => { if (!tapOnlyMode && !contextPinned && !event.currentTarget.matches(":hover") && !event.currentTarget.closest(".rail-cue-card")?.contains(event.relatedTarget as Node | null)) leaveCueHover(cue.id); }} onClick={() => noteMode ? onNoteTarget({ type: "cue", id: cue.id }, { page: cue.page, selectedText: cue.selectedText, enclosingLine: cue.enclosingLine, anchorX: cue.anchorX ?? .08, anchorY: cue.anchorY ?? .12 }) : onSelectCue(cue.id)}>
        <i aria-hidden="true" /><span className="aligned-cue-content"><span className="aligned-cue-top"><b>{cueCardNumber(cue)}</b></span><span className="aligned-cue-title">{cue.title}</span><span className="aligned-cue-intention">{cue.description || "No lighting intention yet."}</span></span>
      </button>{noteCount > 0 && <button type="button" className="cue-note-badge" aria-label={`${noteCount} open note threads for ${cueLabel(cue)} ${cue.title}`} onClick={(event) => { event.stopPropagation(); const firstNote = cueNotes.find((note) => note.cueId === cue.id && !note.resolved) ?? cueNotes.find((note) => note.cueId === cue.id && visibleNote(note)); if (layoutMode === "laptop" && firstNote) onOpenDiscussion(firstNote.id); else onOpenCueNotes(cue.id); }}>{noteCount}</button>}<div className="cue-rail-actions" onPointerEnter={event=>{if(isHoverPointer(event))enterCueHover(cue.id);}} onPointerMove={event=>{if(isHoverPointer(event)&&!heldCueIds.has(cue.id))enterCueHover(cue.id);}} onFocusCapture={() => { if (!tapOnlyMode) enterCueHover(cue.id); }} onBlurCapture={(event) => { if (!tapOnlyMode && !contextPinned && !event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null) && !event.currentTarget.parentElement?.matches(":hover")) leaveCueHover(cue.id); }} role="group" aria-label={`Controls for ${cueLabel(cue)} ${cue.title}`}><button type="button" className="item-menu-trigger cue-menu-trigger" aria-label={`Actions for ${cueLabel(cue)} ${cue.title}`} title="More cue actions" onClick={(event) => openCueMenu(event, cue)}><MoreIcon /></button><button type="button" className="cue-add-note" aria-label={`Add note to ${cueLabel(cue)} ${cue.title}`} title="Add note" onClick={(event) => { event.stopPropagation(); onPlaceNote({ type:"cue", id:cue.id }, { page:cue.page, selectedText:cue.selectedText, enclosingLine:cue.enclosingLine, anchorX:cue.anchorX ?? .08, anchorY:cue.anchorY ?? .12 }); }}><NoteIcon /></button><button type="button" className="cue-edit-number" aria-label={`Edit number for ${cueLabel(cue)} ${cue.title}`} title="Change or unassign number" aria-disabled={busyGroups.has(`cue:${cue.id}:assignment`)} onClick={(event) => { event.stopPropagation(); if (!busyGroups.has(`cue:${cue.id}:assignment`)) openCueNumberEditor(cue); }}>#</button></div></div></div>{pendingNote?.kind === "cue" && pendingNote.cueId === cue.id && <PendingNoteComposer pendingNote={pendingNote} cue={cue} commentText={commentText} setCommentText={setCommentText} onCancel={onCancelPendingNote} onPost={onPostPendingNote} />}{layoutMode === "laptop" && cueNotes.filter((note) => note.cueId === cue.id && visibleNote(note)).map((note) => <DiscussionCard key={note.id} surface="rail" discussion={note} profiles={profiles} focused={focusedDiscussionId === note.id} contextPinned={contextMenu?.discussionId === note.id} busy={busyGroups.has(`discussion:${note.id}`)} onOpen={onOpenDiscussion} onDismiss={onDismissDiscussion} onStartReply={startReply} onCancelReply={cancelReply} onPostReply={postReply} onToggleResolved={toggleResolved} replyingToId={replyingToId} replyText={replyText} setReplyText={setReplyText} />)}</div>; })}
      {cues.length === 0 && status === "ready" && <p className="no-page-cues">No cues on this page.</p>}
    </aside>

    <div className={`pdf-page-stage ${reading ? "ready" : status}`} ref={pageRef} role={noteMode || anchorMode ? "button" : "document"} aria-label={noteMode ? `Place a note on script page ${scriptPageNumber(pageNumber)}` : anchorMode ? `Choose a cue position on script page ${scriptPageNumber(pageNumber)}` : `Selectable script page ${scriptPageNumber(pageNumber)}`} tabIndex={noteMode || anchorMode ? 0 : undefined} style={{ width: pageSize.width, height: pageSize.height }} onClick={noteMode ? handlePageClick : undefined} onKeyDown={noteMode || anchorMode ? handlePageKeyDown : undefined}>
      {reading ? <div ref={textLayerRef} className="formatted-page-text">
        <FormattedScriptPage reading={reading} pageNumber={pageNumber} cues={cues} notes={discussions.filter(visibleNote)} compact={layoutMode === "overlap"} onOpenNotes={ids => onOpenDiscussion(ids[0])} onOpenCueNotes={id => { const cue = cues.find(cue => cue.id === id); if (noteMode && cue) onNoteTarget({ type:"cue", id }, { page:cue.page, selectedText:cue.selectedText, enclosingLine:cue.enclosingLine, anchorX:cue.anchorX ?? .08, anchorY:cue.anchorY ?? .12 }); else onOpenCueNotes(id); }} selectedCueId={selectedCueId} hoveredCueId={hoveredCueId} onHoverCue={id => { if (!tapOnlyMode) { if (id) enterCueHover(id); else if (hoveredCueId) leaveCueHover(hoveredCueId); } }} onSelectCue={id => { const cue = cues.find(cue => cue.id === id); if (noteMode && cue) onNoteTarget({ type: "cue", id }, { page: cue.page, selectedText: cue.selectedText, enclosingLine: cue.enclosingLine, anchorX: cue.anchorX ?? .08, anchorY: cue.anchorY ?? .12 }); else onSelectCue(id); }} onGeometry={measureReader} />
        {reading.pages && <footer className="reader-page-break"><span>Page {scriptPageNumber(pageNumber)}</span></footer>}
      </div> : <><div ref={canvasHostRef} className="pdf-canvas-surface" /><div ref={textLayerRef} className="textLayer" /></>}
      {!pendingNote && railCues.filter(({ cue }) => cue.anchorType === "line").map(({ cue, x, y, displayY }) => <em key={cue.id} data-cue-connector={cue.id} className={`cue-connector ${cue.mode}`} style={cueConnectorStyle(cue.anchorType, cue.number, x, y, displayY, railConnectorGap, markerScale, connectorStyles[cue.id])} />)}
      {!reading && layoutMode === "overlap" && scriptNotes.filter(visibleNote).filter((note,index,list) => list.findIndex(other => other.anchorX === note.anchorX && other.anchorY === note.anchorY) === index).map(note => { const group = scriptNotes.filter(other => visibleNote(other) && other.anchorX === note.anchorX && other.anchorY === note.anchorY); return <button type="button" key={note.id} className="pdf-note-marker reader-note-icon" data-discussion-id={note.id} style={{right:4,top:(note.anchorY ?? .12) * pageSize.height}} aria-label={`Open ${group.length} script notes`} onClick={event => { event.stopPropagation(); onOpenDiscussion(note.id); }}><NoteIcon />{group.length > 1 && <b>{group.length}</b>}</button>; })}
      {!reading && resolvedCues.map(({ cue, x, y }) => { const marker = cueMarkerPosition(cue.anchorType, cue.number, x, y, markerScale); const horizontalHitPadding = (44 - marker.width) / 2; const verticalHitPadding = (44 - marker.height) / 2; const markerVariables = { "--marker-width": `${marker.width}px`, "--marker-height": `${marker.height}px`, "--marker-font-size": `${marker.fontSize}px`, "--marker-stem-length": `${Math.round((cue.anchorType === "line" ? 6 : 5) * markerScale * 100) / 100}px` } as CSSProperties; const markerClass = `script-anchor-marker ${cue.mode} ${cue.blackout ? "blackout" : ""} ${outOfOrderCueIds.has(cue.id) ? "out-of-order" : ""} ${cue.anchorType === "line" ? "line-anchor" : "phrase-anchor"} ${cue.id === selectedCueId ? "active" : ""} ${!tapOnlyMode && hoveredCueId === cue.id ? "hover-linked" : ""}`; return <button key={cue.id} type="button" data-cue-id={cue.id} className={`script-anchor-hit ${cue.mode} ${cue.blackout ? "blackout" : ""} ${outOfOrderCueIds.has(cue.id) ? "out-of-order" : ""} ${cue.anchorType === "line" ? "line-anchor" : "phrase-anchor"} ${cue.id === selectedCueId ? "active" : ""} ${!tapOnlyMode && hoveredCueId === cue.id ? "hover-linked" : ""}`} style={{ ...markerVariables, left: marker.left - horizontalHitPadding, top: marker.top - verticalHitPadding }} onFocus={() => { if (!tapOnlyMode) enterCueHover(cue.id); }} onBlur={(event) => { if (!tapOnlyMode && !event.currentTarget.matches(":hover")) leaveCueHover(cue.id); }} onClick={() => noteMode ? onNoteTarget({ type: "cue", id: cue.id }, { page: cue.page, selectedText: cue.selectedText, enclosingLine: cue.enclosingLine, anchorX: cue.anchorX ?? .08, anchorY: cue.anchorY ?? .12 }) : onSelectCue(cue.id)} title={`${cueLabel(cue)}: ${cue.title} · ${cue.anchorType === "line" ? "line" : "word"} cue${cue.blackout ? " · BLACKOUT" : ""} · ${cue.mode === "implemented" ? "implemented" : cue.mode === "unassigned" ? "unassigned" : "planned"}${outOfOrderCueIds.has(cue.id) ? " · number out of order" : ""}`} aria-label={`${cueLabel(cue)}: ${cue.title}`}>
        <span data-cue-id={cue.id} className={markerClass} onPointerEnter={event => { if (isHoverPointer(event)) enterCueHover(cue.id); }} onPointerLeave={() => { if (!tapOnlyMode) leaveCueHover(cue.id); }}><span>{markerLabel(cue.number)}</span></span>{cue.anchorType === "line" && <span className="pdf-line-stem" aria-hidden="true" />}
      </button>})}
      {selectionTool && <div className="selection-tool" style={{ left: selectionTool.left, top: selectionTool.top }}>
        {noteMode ? <button onClick={() => chooseAnchor("phrase")}>＋ Add note here</button> : <><button onClick={() => chooseAnchor("phrase")}>{anchorMode ? "Word cue" : "＋ Cue on word"}</button><button onClick={() => chooseAnchor("line")}>{anchorMode ? "Line cue" : "＋ Cue on line"}</button></>}
        <button onClick={() => void copyText(selectionTool.selectedText)}>Copy</button>
      </div>}
      {positionedScriptNotes.filter(({ pending }) => layoutMode === "laptop" || pending).map(({ discussion, pending, top, key }) => <div className={`script-note-wrap ${pending ? "pending-script-note" : ""}`} data-rail-group-id={`script:${discussion?.id ?? "pending"}`} key={key} style={{ top }}>{pending?.kind === "script" ? <PendingNoteComposer pendingNote={pending} commentText={commentText} setCommentText={setCommentText} onCancel={onCancelPendingNote} onPost={onPostPendingNote} /> : discussion ? <DiscussionCard surface="rail" discussion={discussion} profiles={profiles} focused={focusedDiscussionId === discussion.id} contextPinned={contextMenu?.discussionId === discussion.id} busy={busyGroups.has(`discussion:${discussion.id}`)} onOpen={onOpenDiscussion} onDismiss={onDismissDiscussion} onStartReply={startReply} onCancelReply={cancelReply} onPostReply={postReply} onToggleResolved={toggleResolved} replyingToId={replyingToId} replyText={replyText} setReplyText={setReplyText} /> : null}</div>)}
      {!reading && status === "loading" && <div className="pdf-status"><i /> Rendering page {scriptPageNumber(pageNumber)}</div>}
      {!reading && status === "error" && <div className="pdf-status error"><b>PAGE COULD NOT RENDER</b><button onClick={() => setRenderAttempt((attempt) => attempt + 1)}>Retry</button></div>}
    </div>
    {copyStatus && <span className={`copy-status ${copyStatus}`} role="status">{copyStatus === "copied" ? "Copied to clipboard" : "Could not copy. Select the text and copy it manually."}</span>}
    {contextMenu && createPortal(<div ref={contextMenuRef} className="script-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="group" aria-label="Script actions">
      {contextMenu.target === "script" && <><button className="menu-note" onClick={() => { setContextMenu(null); onPlaceNote(null, contextMenu.phraseDraft); }}>Add note</button><button className="menu-cue" onClick={() => { setContextMenu(null); onAnchorChosen(contextMenu.phraseDraft, "phrase"); }}>{contextMenu.phraseDraft.selectedText.includes(" ") ? "Add phrase cue" : "Add word cue"}</button><button className="menu-cue" onClick={() => { setContextMenu(null); onAnchorChosen(contextMenu.lineDraft, "line"); }}>Add line cue</button><button className="menu-neutral" onClick={() => { setContextMenu(null); void copyText(contextMenu.phraseDraft.selectedText); }}>Copy text</button></>}
      {contextMenu.target === "cue" && contextMenu.cueId && (() => { const cue = cues.find((item) => item.id === contextMenu.cueId); if (!cue) return null; const assignmentBusy = busyGroups.has(`cue:${cue.id}:assignment`); const positionBusy = busyGroups.has(`cue:${cue.id}:position`); return <><div className="context-menu-group" role="group" aria-label="Note actions"><button className="menu-note" onClick={() => { setContextMenu(null); onPlaceNote({ type: "cue", id: cue.id }, contextMenu.phraseDraft); }}>Add note</button></div><div className="context-menu-group" role="group" aria-label="Number and position actions">{cue.number ? <button className="menu-number" disabled={assignmentBusy} onClick={() => openCueNumberEditor(cue)}>Change number</button> : <button className="menu-number" disabled={assignmentBusy || positionBusy} onClick={() => openCueNumberEditor(cue)}>Assign number</button>}<button className="menu-cue" disabled={assignmentBusy || positionBusy} onClick={() => { setContextMenu(null); onMoveCue(cue.id); }}>Move cue</button>{cue.number && <button className="menu-number" disabled={assignmentBusy} onClick={() => { setContextMenu(null); onUnassignCueNumber(cue.id); }}>Unassign number</button>}</div><div className="context-menu-group" role="group" aria-label="Cue status actions">{cue.number && cue.mode !== "unassigned" && <button className="menu-status" disabled={assignmentBusy} onClick={() => { setContextMenu(null); onToggleCueMode(cue.id); }}>{cue.mode === "implemented" ? "Mark Planned" : "Mark Implemented"}</button>}<button className="menu-blackout" disabled={busyGroups.has(`cue:${cue.id}:blackout`)} onClick={() => { setContextMenu(null); onToggleCueBlackout(cue.id); }}>{cue.blackout ? "Remove Blackout" : "Mark as Blackout"}</button></div><div className="context-menu-group" role="group" aria-label="Delete cue"><button className="menu-danger" disabled={busyGroups.has(`cue:${cue.id}:lifecycle`)} onClick={() => { setContextMenu(null); onDeleteCue(cue.id); }}>Delete cue…</button></div></>; })()}
      {contextMenu.target === "scene" && contextMenu.sceneId && <><button className="menu-note" onClick={() => { setContextMenu(null); onPlaceNote({ type: "scene", id: contextMenu.sceneId! }, contextMenu.phraseDraft); }}>Add note</button><button className="menu-neutral" onClick={() => { setContextMenu(null); onOpenScene(contextMenu.sceneId!); }}>Open scene</button></>}
      {contextMenu.target === "note" && contextMenu.discussionId && <><button className="menu-cue" disabled={busyGroups.has(`discussion:${contextMenu.discussionId}`)} onClick={() => { setContextMenu(null); onReplyNote(contextMenu.discussionId!); }}>Reply to note</button><button className="menu-status" disabled={busyGroups.has(`discussion:${contextMenu.discussionId}`)} onClick={() => { const discussion = discussions.find((candidate) => candidate.id === contextMenu.discussionId); setContextMenu(null); if (discussion) toggleResolved(discussion); }}>{discussions.find((candidate) => candidate.id === contextMenu.discussionId)?.resolved ? "Reopen" : "Resolve"}</button></>}
    </div>, document.body)}
  </div>;
}

function PendingNoteComposer({ pendingNote, cue, commentText, setCommentText, onCancel, onPost }: {
  pendingNote: PendingNote;
  cue?: Cue;
  commentText: string;
  setCommentText: (value: string) => void;
  onCancel: () => void;
  onPost: () => void;
}) {
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const target = cue
    ? `CUE ${cueLabel(cue)} · ${cue.title}`
    : pendingNote.anchor.selectedText
      ? `SCRIPT · ${pendingNote.anchor.selectedText}`
      : `SCRIPT · ${pendingNote.anchor.enclosingLine || "selected line"}`;
  const pendingKey = `${pendingNote.kind}:${pendingNote.kind === "cue" ? pendingNote.cueId : pendingNote.anchor.page}:${pendingNote.anchor.anchorY}`;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      if (window.matchMedia("(max-width: 1024px)").matches) composerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingKey]);

  const cancel = () => {
    onCancel();
    window.requestAnimationFrame(() => {
      const cueRow = cue ? document.querySelector<HTMLButtonElement>(`.aligned-cue-row[data-cue-id="${CSS.escape(cue.id)}"]`) : null;
      if (!cueRow?.getClientRects().length) { document.querySelector<HTMLButtonElement>(".topbar-add-note")?.focus(); return; }
      cueRow.focus({ preventScroll:true });
      const frame = cueRow.closest<HTMLElement>(".pdf-frame");
      if (!frame) return;
      const rowBox = cueRow.getBoundingClientRect(), frameBox = frame.getBoundingClientRect();
      const context = frame.querySelector<HTMLElement>(".sticky-scene-row .aligned-scene-card")?.getBoundingClientRect();
      // Textarea autofocus can leave its cue behind the sticky scene card.
      // Return to that cue on cancel, leaving room for its vertical controls.
      if (rowBox.top < (context?.bottom ?? frameBox.top) + 8 || rowBox.bottom > frameBox.bottom) {
        frame.scrollTo({ top:Math.max(0,frame.scrollTop + rowBox.top - frameBox.top - frame.clientHeight * .3), behavior:"smooth" });
      }
    });
  };
  const post = () => {
    if (commentText.trim()) onPost();
  };
  return <div ref={composerRef} className="pending-note-composer" role="group" aria-label={`Draft note for ${target}`} data-pending-note-kind={pendingNote.kind}>
    <span className="pending-note-label" aria-live="polite">DRAFT NOTE</span>
    <span className="pending-note-target">{target}</span>
    <textarea ref={textareaRef} aria-label={`Draft note for ${target}`} maxLength={FIELD_LIMITS.note} value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder="Write a note…" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); post(); } if (event.key === "Escape") { event.preventDefault(); cancel(); } }} />
    <small className={`composer-limit ${commentText.length > FIELD_LIMITS.note ? "over" : ""}`}>{commentText.length > FIELD_LIMITS.note ? `Shorten by ${(commentText.length - FIELD_LIMITS.note).toLocaleString()} characters` : `${commentText.length.toLocaleString()} / ${FIELD_LIMITS.note.toLocaleString()}`}</small>
    <div className="pending-note-actions"><button type="button" onClick={cancel}>Cancel</button><button type="button" className="primary-button" disabled={!commentText.trim() || commentText.length > FIELD_LIMITS.note} onClick={post}>Post note</button></div>
  </div>;
}
