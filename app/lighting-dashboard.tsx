"use client";

import { ShowMenu } from "../desktop/show-menu";
import { createPortal } from "react-dom";
import { holdInert } from "../lib/inert";
import { deletedCueForActivity } from "../lib/activity-navigation";
import { ScriptReadingProgress } from "./script-reading-progress";
import { ScriptWorkspace } from "./script-workspace";
import { CUE_MOTION_MS, useCuePresence } from "./use-cue-presence";
import { initialPreferences, writePreference, type ScriptReadingPreferences } from "../lib/ui-preferences";
import { Activity, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { formatCueNumber, normalizeCueNumbers, NUMBER_SPACE_ERROR, parseCueNumber, planCueNumberAssignments, autoNumberForPlacement, cueNumberSuffix, findOutOfOrderCueIds, isValidCueSuffix, orderCuePlacements, sanitizeCueSuffix, sortCuesByPosition } from "../lib/cue-numbering";
import { defaultState } from "../lib/default-state";
import { CUE_NUMBER_PREFIX, FIELD_LIMITS, exceedsLimit } from "../lib/field-limits";
import { activityRequiresAction, activitySceneIds, activityTypeGroup, collapseResolutionEvents, currentInboxEventsForProfile, isActivityCurrent, isActivityForProfile, isActivityPinned, isActivityRead, stackInboxEvents, type InboxEventStack, type InboxType } from "../lib/inbox";
import { hexToHue, hueToHex } from "../lib/profile-color";
import { buildSceneGroups, sceneAtPosition } from "../lib/scene-boundaries";
import { FIRST_SCRIPT_PDF_PAGE, pdfPageNumber, scriptPageCount, scriptPageNumber } from "../lib/script-page-number";
import { startSheetResize } from "../lib/sheet-resize";
import type { ActivityType, Cue, Discussion, HistoryEvent, Profile, Scene, WorkspaceConflictRecord, WorkspaceState } from "../lib/types";
import { addDiscussionReply, moveCueToTrash, restoreCueFromTrash, saveProfile } from "../lib/workspace-actions";
import { filterWorkspaceSearchResults, limitQuickSearchResults, paginateWorkspaceSearchResults, searchWorkspace, type ScriptSearchPage, type WorkspaceSearchKind, type WorkspaceSearchResult } from "../lib/workspace-search";
import { acknowledgeWorkspaceConflictGroup, createWorkspacePatchMutation, createWorkspaceRecoveryMutation, groupWorkspaceConflictRecords, isWorkspaceRecoveryMutation, mergeWorkspaceStates, recordWorkspaceConflicts, resolveWorkspaceConflictGroup, type WorkspaceConflictGroup, type WorkspaceMutation, type WorkspaceRecoveryMutation, type WorkspaceSnapshot } from "../lib/workspace-sync";
import { recoverWorkspace } from "../lib/workspace-recovery";
import { recoveryItemGroups, SyncV2Client, type BootstrapPayload } from "../lib/sync-v2/client";
import { ACTIVE_SYNC_ENGINE } from "../lib/sync-engine";
import type { SyncRecoveryItem } from "../lib/sync-v2/client-store";
import type { ConnectionState, SaveState as SyncV2SaveState, SyncAction, SyncNoticeRecord } from "../lib/sync-v2/protocol";
import type { ProjectionVersions } from "../lib/sync-v2/reducer";
import { operationNeedsAttention, operationNotice, syncNotice } from "../lib/sync-v2/notifications";
import { DiscussionCard } from "./discussion-card";
import { CueIcon, ArrowIcon, CloseIcon } from "./script-icons";
import { discussionTargetType } from "../lib/discussion-ui";
import { shareWorkspaceState } from "../lib/workspace-sharing";
import { PdfScriptViewer, type NoteVisibility, type PdfAnchorDraft, type PendingNote } from "./pdf-script-viewer";
import { SyncRecoveryInbox } from "./sync-recovery-inbox";

const desktopMode = typeof window !== "undefined" && !!window.desktop;

type View = "script" | "cues" | "inbox" | "scenes" | "search";
type ThemePreference = "dark" | "light";
type AnchorRequest = { mode: "create"; assignNumber: boolean } | { mode: "edit"; cueId: string } | { mode: "note" };
type ScriptJumpRequest = { page: number; anchorY?: number; key: string; preservePosition?: boolean; preserveCueId?: string; preserveTop?: boolean };
let scriptSearchCache: { key: string; promise: Promise<ScriptSearchPage[]> } | null = null;
type SearchResult = WorkspaceSearchResult;
type TextHistoryVersion = { revision: number; sequence: number; operationId: string; title: string; description: string; technicalNotes: string; actorId: string; createdAt: string };

const nav: { id: View; label: string; glyph: string }[] = [
  { id: "script", label: "Script", glyph: "▤" },
  { id: "scenes", label: "Scenes", glyph: "◇" },
  { id: "cues", label: "Cues", glyph: "▦" },
  { id: "inbox", label: "Inbox", glyph: "⇩" },
];
const exactSceneStarts = new Map(defaultState.scenes.map((scene) => [scene.id, scene.startY]));
const legacyRecoveryMutationKey = "lt-pending-workspace-mutation";
const recoveryDiagnosticsKey = `${legacyRecoveryMutationKey}:diagnostics`;
let tabRecoveryKey: string | null = null;

function recoveryMutationKey() {
  if (tabRecoveryKey) return tabRecoveryKey;
  if (typeof window === "undefined") return legacyRecoveryMutationKey;
  try {
    // A duplicated tab can inherit sessionStorage. Use a fresh page token and
    // recover older tokens by scanning them on startup instead of sharing a
    // write slot between tabs.
    const tabId = globalThis.crypto?.randomUUID?.() ?? uid("tab");
    tabRecoveryKey = `${legacyRecoveryMutationKey}:${tabId}`;
  } catch {
    tabRecoveryKey = `${legacyRecoveryMutationKey}:${uid("tab")}`;
  }
  return tabRecoveryKey;
}

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const cueLabel = (cue: Pick<Cue, "number">) => formatCueNumber(cue.number);
function cueNoteCounts(discussions: Discussion[], visibility: NoteVisibility): Record<string, number> {
  const counts: Record<string, number> = {};
  if (visibility === "none") return counts;
  for (const discussion of discussions) if (discussionTargetType(discussion) === "cue" && discussion.cueId && !discussion.resolved) counts[discussion.cueId] = (counts[discussion.cueId] ?? 0) + 1;
  return counts;
}

type RecoveryMutation = WorkspaceMutation;

type DurableRecoveryMutation = WorkspaceMutation | WorkspaceRecoveryMutation;
type RecoveryIssue = { key: string; mutationId?: string; message: string; raw?: string; retryable?: boolean };
type RecoveryRead = { records: RecoveryRecord[]; issues: RecoveryIssue[]; exportItems: Array<{ key: string; raw: string }> };
type SavedNoteDraft = { text: string; pendingNote: PendingNote };

function readSavedNoteDraft(value: string): SavedNoteDraft | null {
  try {
    const parsed = JSON.parse(value) as Partial<SavedNoteDraft>;
    if (typeof parsed.text !== "string" || !parsed.pendingNote || !["cue", "script"].includes(parsed.pendingNote.kind)) return null;
    return parsed as SavedNoteDraft;
  } catch { return null; }
}

function isRecoveryState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<WorkspaceState>;
  const collections = [candidate.profiles, candidate.scenes, candidate.cues, candidate.discussions, candidate.history, candidate.inboxReads, candidate.inboxPins, candidate.deletedCues];
  return Number.isSafeInteger(candidate.schemaVersion)
    && !!candidate.document && typeof candidate.document === "object"
    && collections.every((items) => Array.isArray(items) && items.every((item) => !!item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"));
}

function storeRecoveryMutation(mutation: DurableRecoveryMutation) {
  const durable = "base" in mutation && "next" in mutation
    ? createWorkspaceRecoveryMutation(mutation.base, mutation.next, mutation.baseRevision, mutation.mutationId)
    : mutation;
  try {
    localStorage.setItem(recoveryMutationKey(), JSON.stringify(durable));
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, message: error instanceof DOMException && error.name === "QuotaExceededError" ? "Browser storage is full" : "Browser storage is unavailable" };
  }
}

type RecoveryRecord = { mutation: DurableRecoveryMutation; keys: string[] };

function parseRecoveryMutation(raw: string | null): { mutation: DurableRecoveryMutation | null; error?: string } {
  if (!raw) return { mutation: null, error: "The saved recovery record is empty." };
  try {
    const value = JSON.parse(raw) as Partial<WorkspaceMutation> | unknown;
    if (isWorkspaceRecoveryMutation(value)) return { mutation: value };
    if (!value || typeof value !== "object" || Array.isArray(value)) return { mutation: null, error: "The saved recovery record is not an object." };
    const candidate = value as Partial<WorkspaceMutation>;
    if (typeof candidate.baseRevision !== "number" || !Number.isSafeInteger(candidate.baseRevision) || candidate.baseRevision < 0 || typeof candidate.mutationId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(candidate.mutationId)) {
      return { mutation: null, error: "The saved recovery record has invalid mutation metadata." };
    }
    if (!isRecoveryState(candidate.base) || !isRecoveryState(candidate.next)) return { mutation: null, error: "The saved recovery record has an invalid workspace snapshot." };
    return { mutation: candidate as WorkspaceMutation };
  } catch { return { mutation: null, error: "The saved recovery record is not valid JSON." }; }
}

function readRecoveryMutations(): RecoveryRead {
  try {
    const values = new Map<string, RecoveryRecord>();
    const issues: RecoveryIssue[] = [];
    const exportItems: Array<{ key: string; raw: string }> = [];
    const keys = [legacyRecoveryMutationKey, recoveryMutationKey()];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(`${legacyRecoveryMutationKey}:`) && key !== recoveryDiagnosticsKey) keys.push(key);
    }
    let diagnostics: Record<string, string> = {};
    try { diagnostics = JSON.parse(localStorage.getItem(recoveryDiagnosticsKey) ?? "{}"); } catch { /* The raw records remain exportable. */ }
    [...new Set(keys)].forEach((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      exportItems.push({ key, raw });
      const parsed = parseRecoveryMutation(raw);
      if (!parsed.mutation) {
        issues.push({ key, message: parsed.error ?? "The saved recovery record could not be read.", raw });
        return;
      }
      const diagnostic = diagnostics[parsed.mutation.mutationId];
      if (diagnostic) {
        issues.push({ key, mutationId: parsed.mutation.mutationId, message: diagnostic, raw });
        return;
      }
      const mutation = parsed.mutation;
      const existing = values.get(mutation.mutationId);
      if (existing) existing.keys.push(key);
      else values.set(mutation.mutationId, { mutation, keys: [key] });
    });
    return { records: [...values.values()], issues, exportItems };
  } catch { return { records: [], issues: [{ key: "localStorage", message: "Browser storage is unavailable." }], exportItems: [] }; }
}

function clearRecoveryMutation(mutationId: string, sourceKeys: string[] = []) {
  try {
    const keys = [recoveryMutationKey(), legacyRecoveryMutationKey, ...sourceKeys];
    keys.forEach((key) => {
      const raw = localStorage.getItem(key);
      const stored = raw ? (() => { try { return JSON.parse(raw) as Partial<RecoveryMutation>; } catch { return null; } })() : null;
      if (stored?.mutationId === mutationId) localStorage.removeItem(key);
    });
    const diagnostics = (() => { try { return JSON.parse(localStorage.getItem(recoveryDiagnosticsKey) ?? "{}") as Record<string, string>; } catch { return {}; } })();
    delete diagnostics[mutationId];
    localStorage.setItem(recoveryDiagnosticsKey, JSON.stringify(diagnostics));
  } catch { /* A successful server save is still authoritative. */ }
}

function markRecoveryFailure(mutationId: string, message: string) {
  try {
    const diagnostics = (() => { try { return JSON.parse(localStorage.getItem(recoveryDiagnosticsKey) ?? "{}"); } catch { return {}; } })() as Record<string, string>;
    diagnostics[mutationId] = message;
    localStorage.setItem(recoveryDiagnosticsKey, JSON.stringify(diagnostics));
  } catch { /* The visible issue and export route still protect the current tab. */ }
}

async function loadScriptSearchPages(firstPage: number, lastPage: number) {
  const key = `${firstPage}:${lastPage}`;
  if (scriptSearchCache?.key === key) return scriptSearchCache.promise;
  const promise = Promise.resolve().then(async () => {
    try {
      const response = await fetch("/script-search-index.json", { cache: "force-cache" });
      if (!response.ok) throw new Error("Static script index unavailable");
      const index = await response.json() as { version?: number; pages?: ScriptSearchPage[] };
      if (index.version !== 1 || !Array.isArray(index.pages)) throw new Error("Static script index is invalid");
      return index.pages.filter((page) => Number.isInteger(page.page) && typeof page.text === "string" && page.page >= firstPage && page.page <= lastPage);
    } catch { /* Fall back to extracting the fixed PDF if the static index is missing. */ }
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    const document = await pdfjs.getDocument({ url: "/api/script", withCredentials: true }).promise;
    try {
      const pages: ScriptSearchPage[] = [];
      for (let pageNumber = firstPage; pageNumber <= Math.min(lastPage, document.numPages); pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push({ page: pageNumber, text: content.items.map((item) => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim() });
        page.cleanup();
      }
      return pages;
    } finally {
      await (document as typeof document & { destroy?: () => Promise<void> }).destroy?.();
    }
  });
  scriptSearchCache = { key, promise };
  promise.catch(() => { if (scriptSearchCache?.promise === promise) scriptSearchCache = null; });
  return promise;
}

function normalizeWorkspaceScenes(workspace: WorkspaceState) {
  let changed = false;
  const scenes = workspace.scenes.map((scene) => {
    if (Number.isFinite(scene.startY)) return scene;
    changed = true;
    return { ...scene, startY: exactSceneStarts.get(scene.id) ?? 0 };
  });
  const discussions = (workspace.discussions ?? []).map((discussion) => {
    const normalized = { ...discussion, targetType: discussion.targetType ?? (discussion.cueId ? "cue" : discussion.sceneId ? "scene" : "script"), replies: discussion.replies ?? [], resolved: discussion.resolved ?? false };
    if (normalized.targetType !== discussion.targetType || normalized.replies !== discussion.replies || normalized.resolved !== discussion.resolved) changed = true;
    return normalized;
  });
  return changed || !workspace.inboxReads || !workspace.inboxPins ? { ...workspace, scenes, discussions, inboxReads: workspace.inboxReads ?? [], inboxPins: workspace.inboxPins ?? [] } : workspace;
}

async function decodeSnapshot(response: Response): Promise<WorkspaceSnapshot> {
  const body = await response.json() as WorkspaceSnapshot | WorkspaceState;
  const legacyGeneration = response.headers.get("x-legacy-generation") ?? undefined;
  if ("state" in body && typeof body.revision === "number") return { ...body as WorkspaceSnapshot, legacyGeneration: (body as WorkspaceSnapshot).legacyGeneration ?? legacyGeneration };
  return {
    state: body as WorkspaceState,
    revision: Number(response.headers.get("x-workspace-revision") ?? 0),
    updatedAt: new Date().toISOString(),
    legacyGeneration,
  };
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const upstream = init.signal;
  const abortFromUpstream = () => controller.abort();
  upstream?.addEventListener("abort", abortFromUpstream, { once: true });
  try {
    if (upstream?.aborted) controller.abort();
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = response.status === 304 || response.status === 204 ? null : await response.arrayBuffer();
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    window.clearTimeout(timer);
    upstream?.removeEventListener("abort", abortFromUpstream);
  }
}

function timeAgo(value: string) {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function openWorkspaceConflicts(state: WorkspaceState): WorkspaceConflictRecord[] {
  return (state.conflicts ?? []).filter((conflict) => conflict.status === "open");
}

function ProfileMark({ profile, small = false }: { profile?: Profile; small?: boolean }) {
  return <span className={`profile-mark ${small ? "small" : ""}`} style={{ "--profile": profile?.color ?? "var(--muted)" } as React.CSSProperties}>{profile?.initials ?? "?"}</span>;
}

function searchResultKey(result: SearchResult) {
  if (result.kind === "cue") return `cue-${result.cue.id}`;
  if (result.kind === "discussion") return `discussion-${result.discussion.id}`;
  if (result.kind === "scene") return `scene-${result.scene.id}`;
  return `script-${result.page}`;
}

function SearchResultRow({ result, onOpen, selected = false, id }: { result: SearchResult; onOpen: () => void; selected?: boolean; id?: string }) {
  const shared = { type: "button" as const, role: "option", id, onClick: onOpen, "aria-selected": selected || undefined };
  if (result.kind === "cue") return <button {...shared} className={`${result.cue.mode} ${result.cue.blackout ? "blackout" : ""} ${selected ? "search-selected" : ""}`}><span>{cueLabel(result.cue)}</span><strong>{result.cue.title}</strong><small>CUE · Page {scriptPageNumber(result.cue.page)} · {result.matchLabel}</small></button>;
  if (result.kind === "discussion") return <button {...shared} className={`discussion-result ${selected ? "search-selected" : ""}`}><span>NOTE</span><strong>{result.discussion.content}</strong><small>{result.cue ? `${cueLabel(result.cue)} · Page ${scriptPageNumber(result.cue.page)}` : result.scene ? `SCENE ${result.scene.number} · Page ${scriptPageNumber(result.scene.pageStart)}` : `SCRIPT · Page ${result.discussion.page ? scriptPageNumber(result.discussion.page) : "?"}`} · {result.matchLabel}</small></button>;
  if (result.kind === "scene") return <button {...shared} className={`scene-result ${selected ? "search-selected" : ""}`}><span>SCENE {result.scene.number}</span><strong>{result.scene.name}</strong><small>SCENE · Pages {scriptPageNumber(result.scene.pageStart)}–{scriptPageNumber(result.scene.pageEnd)} · {result.matchLabel}</small></button>;
  return <button {...shared} className={`script-result ${selected ? "search-selected" : ""}`}><span>PAGE {scriptPageNumber(result.page)}</span><strong>{result.snippet}</strong><small>{result.matchLabel}</small></button>;
}

function conflictValue(value: unknown) {
  if (value === undefined) return "Deleted";
  if (typeof value === "string") return value || "(blank)";
  try {
    const serialized = JSON.stringify(value);
    return serialized;
  } catch { return String(value); }
}

const conflictFieldNames: Record<string, string> = {
  title: "Cue title",
  description: "Lighting intention",
  technicalNotes: "Technical notes",
  number: "Cue number",
  mode: "Cue status",
  blackout: "Blackout status",
  ownerId: "Owner",
};

function conflictFieldName(conflict: WorkspaceConflictRecord) {
  return conflictFieldNames[conflict.pathSegments.at(-1) ?? ""] ?? conflict.path.replace(/\[[^\]]+\]/g, "").replace(/^\./, "");
}

function conflictHistoryMatches(event: HistoryEvent, conflict: WorkspaceConflictRecord) {
  const field = conflict.pathSegments.at(-1);
  if (event.cueId !== conflict.pathSegments[1]) return false;
  if (field === "number") return event.type === "cue_number";
  if (field === "mode") return event.type === "cue_status";
  if (field === "blackout") return event.type === "cue_blackout";
  if (event.type !== "cue_edited") return false;
  if (field === "title") return /title/i.test(event.text);
  if (field === "description") return /lighting intention/i.test(event.text);
  if (field === "technicalNotes") return /technical/i.test(event.text);
  return false;
}

function savedEditDetails(group: WorkspaceConflictGroup, state: WorkspaceState) {
  const detectedAt = Date.parse(group.latest.createdAt);
  const event = state.history.find((item) => {
    const eventAt = Date.parse(item.createdAt);
    return conflictHistoryMatches(item, group.latest) && eventAt <= detectedAt + 5_000 && detectedAt - eventAt <= 30 * 60_000;
  });
  return event ? { profile: state.profiles.find((item) => item.id === event.actorId), createdAt: event.createdAt } : null;
}

function conflictClock(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function conflictWordDiff(incoming: string, remote: string) {
  const left = incoming.split(/(\s+)/);
  const right = remote.split(/(\s+)/);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  return {
    prefix: left.slice(0, prefix).join(""),
    incoming: left.slice(prefix, suffix ? -suffix : undefined).join(""),
    remote: right.slice(prefix, suffix ? -suffix : undefined).join(""),
    suffix: suffix ? left.slice(-suffix).join("") : "",
  };
}

function ConflictNotice({ conflicts, state, active, onChoose, onAcknowledge }: { conflicts: WorkspaceConflictRecord[]; state: WorkspaceState; active?: Profile; onChoose: (conflict: WorkspaceConflictRecord, choice: "remote" | "incoming") => void; onAcknowledge: (conflict: WorkspaceConflictRecord) => void }) {
  const groups = groupWorkspaceConflictRecords(conflicts);
  if (!groups.length) return null;
  return <section className="workspace-conflicts" role="alertdialog" aria-modal="true" aria-labelledby="workspace-conflict-title">
    <header><div><span>SYNC CONFLICT</span><h2 id="workspace-conflict-title">Choose which version to keep</h2></div><strong>{groups.length} conflict{groups.length === 1 ? "" : "s"}</strong></header>
    <p className="workspace-conflict-intro">Two people changed the same field before either edit reached the other browser. Other changes have already merged.</p>
    {groups.map((group, index) => {
      const conflict = group.latest;
      const savedEdit = savedEditDetails(group, state);
      const incomingLabel = active?.name ?? "Your";
      const remoteLabel = savedEdit?.profile?.name ?? "Saved";
      const incomingValue = conflictValue(conflict.incoming);
      const remoteValue = conflictValue(conflict.remote);
      const isTextConflict = typeof conflict.incoming === "string" && typeof conflict.remote === "string" && !["mode", "number", "ownerId"].includes(conflict.pathSegments.at(-1) ?? "");
      const diff = isTextConflict ? conflictWordDiff(incomingValue, remoteValue) : null;
      return <article key={group.key}>
        <div className="workspace-conflict-heading"><div><small>CONFLICT {index + 1} OF {groups.length}</small><strong>{conflictFieldName(conflict)}</strong></div><span>Detected {conflictClock(conflict.createdAt)}</span></div>
        {conflict.kind === "number-repair" ? <><p className="workspace-conflict-repair">The requested number {incomingValue} was already in use. This cue was assigned {conflictValue(conflict.repaired)}; the existing cue kept its number.</p><button className="workspace-conflict-acknowledge" type="button" onClick={() => onAcknowledge(conflict)}>Keep assigned number</button></> : <div className={`workspace-conflict-values ${diff ? "word-diff" : "choice-cards"}`}><button type="button" onClick={() => onChoose(conflict, "incoming")}><small>{incomingLabel.toUpperCase()} · YOUR BROWSER</small><span>{diff ? <>{diff.prefix}<mark className="diff-removed">{diff.incoming || "(blank)"}</mark>{diff.suffix}</> : incomingValue}</span><b>Keep {incomingLabel}&apos;s edit</b></button><button type="button" onClick={() => onChoose(conflict, "remote")}><small>{remoteLabel.toUpperCase()}{savedEdit ? ` · ${conflictClock(savedEdit.createdAt)}` : ""}</small><span>{diff ? <>{diff.prefix}<mark className="diff-added">{diff.remote || "(blank)"}</mark>{diff.suffix}</> : remoteValue}</span><b>Keep {remoteLabel}&apos;s edit</b></button></div>}
        <details className="workspace-conflict-technical"><summary>Technical details</summary><pre>{JSON.stringify({ path: conflict.path, id: conflict.id, occurrenceId: conflict.occurrenceId, createdAt: conflict.createdAt, base: conflict.base, incoming: conflict.incoming, remote: conflict.remote }, null, 2)}</pre></details>
      </article>;
    })}
  </section>;
}

type QaRedTarget = { cueId: string; kind: "structured" | "text"; point: string };
function QaRedFaultRunner({ ready, run }: { ready: () => boolean; run: () => Promise<void> }) {
  const started = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (started.current || !ready()) return;
      started.current = true;
      window.clearInterval(timer);
      void run().catch((failure) => setError(failure instanceof Error ? failure.message : "Could not start the QA faults."));
    }, 100);
    const timeout = window.setTimeout(() => { if (!started.current) { window.clearInterval(timer); setError("QA fault cues did not load. Reload or start a new run from Fault Lab."); } }, 15_000);
    return () => { window.clearInterval(timer); window.clearTimeout(timeout); };
  }, [ready, run]);
  return error ? <aside className="workspace-recovery-warning" role="alert"><strong>QA fault test stopped</strong><p>{error}</p></aside> : null;
}

export function LightingDashboard({ qaTesting = false }: { qaTesting?: boolean }) {
  const [state, setState] = useState<WorkspaceState>(defaultState);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [preferences] = useState(initialPreferences);
  const [preferenceStorageUnavailable, setPreferenceStorageUnavailable] = useState(preferences.unavailable);
  const savePreference = (key: string, value: string) => { if (!writePreference(key, value)) setPreferenceStorageUnavailable(true); };
  const [activeId, setActiveId] = useState<string | null>(desktopMode ? "local" : preferences.profile);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [view, setView] = useState<View>("script");
  const [selectedCueId, setSelectedCueId] = useState<string | null>("cue-2");
  const [cueListPanelOpen, setCueListPanelOpen] = useState(false);
  const cueListReturnFocusRef = useRef<HTMLElement|null>(null);
  const cueListPendingFocusRef = useRef<HTMLElement|null>(null);
  const [cuePanelExpanded, setCuePanelExpanded] = useState(false);
  const [cuePanelCompact, setCuePanelCompact] = useState(false);
  useEffect(() => {
    const resize = () => {
      const frame = document.querySelector<HTMLElement>(".pdf-frame"), layout = frame?.closest(".script-layout");
      const available = (frame?.clientWidth ?? window.innerWidth) + (layout?.classList.contains("detail-open") ? 360 : 0);
      setCuePanelCompact(window.innerWidth < 900 || Boolean(frame?.querySelector(".formatted-script") && available < 800));
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [cuePanelClosing, setCuePanelClosing] = useState(false);
  useEffect(() => {
    if (!cuePanelClosing) return;
    const timer = window.setTimeout(() => { cueListPendingFocusRef.current=cueListReturnFocusRef.current;cueListReturnFocusRef.current=null;setSelectedCueId(null); setCueListPanelOpen(false); setCuePanelClosing(false); }, CUE_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [cuePanelClosing]);
  useEffect(() => {
    if (selectedCueId !== null) return;
    const target=cueListPendingFocusRef.current;
    cueListPendingFocusRef.current=null;
    // Child editor cleanup has now removed inert from the list.
    if (target?.isConnected) target.focus({preventScroll:true});
  }, [selectedCueId]);
  const [newCueFocusId, setNewCueFocusId] = useState<string | null>(null);
  const [scriptPage, setScriptPage] = useState(FIRST_SCRIPT_PDF_PAGE);
  const [, setScriptSceneId] = useState<string | null>("scene-01");
  const [pdfScale, setPdfScale] = useState(1.35);
  const [scriptReading, setScriptReading] = useState(preferences.reading);
  const updateScriptReading = (patch: Partial<ScriptReadingPreferences>) => {
    const next: ScriptReadingPreferences = { ...scriptReading, ...patch, view: "formatted" };
    setScriptReading(next);
    savePreference("lt-script-reading", JSON.stringify(next));
  };
  const [noteVisibility, setNoteVisibility] = useState<NoteVisibility>("active");
  const [noteVisibilityMenuOpen, setNoteVisibilityMenuOpen] = useState(false);
  const [pageKeypadOpen, setPageKeypadOpen] = useState(false);
  const [pageDraft, setPageDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchClosing, setSearchClosing] = useState(false);
  const [qaRedTargets, setQaRedTargets] = useState<QaRedTarget[] | null>(() => {
    const encoded = typeof window !== "undefined" && qaTesting ? new URLSearchParams(window.location.search).get("qa-red") : null;
    if (!encoded) return null;
    try {
      const targets: unknown = JSON.parse(encoded);
      return Array.isArray(targets) && targets.length > 0 && targets.length <= 5 && targets.every((target) => target && typeof target === "object" && /^qa-fault-[a-z0-9-]{8,80}$/.test(target.cueId) && ["structured", "text"].includes(target.kind)) ? targets as QaRedTarget[] : null;
    } catch { return null; }
  });
  const [search, setSearch] = useState("");
  const [searchSelection, setSearchSelection] = useState(0);
  const [searchShortcut, setSearchShortcut] = useState("Ctrl K");
  useEffect(() => { const frame = requestAnimationFrame(() => setSearchShortcut(/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K")); return () => cancelAnimationFrame(frame); }, []);
  const [theme, setTheme] = useState<ThemePreference>(preferences.theme);
  const [searchTypeFilter, setSearchTypeFilter] = useState<"all" | WorkspaceSearchKind>("all");
  const [searchPersonFilter, setSearchPersonFilter] = useState("all");
  const [searchSceneFilter, setSearchSceneFilter] = useState("all");
  const [searchPage, setSearchPage] = useState(1);
  const [modeFilter, setModeFilter] = useState("all");
  const [inboxScope, setInboxScope] = useState<"for-you" | "all">("for-you");
  const [inboxScene, setInboxScene] = useState("all");
  const [inboxType, setInboxType] = useState<InboxType>("all");
  const [commentText, setCommentText] = useState("");
  const [pendingNote, setPendingNote] = useState<PendingNote | null>(null);
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [focusedDiscussionId, setFocusedDiscussionId] = useState<string | null>(null);
  const [cueNotesRequest, setCueNotesRequest] = useState(0);
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState<Profile | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [numberTargetId, setNumberTargetId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashFocusId, setTrashFocusId] = useState<string | null>(null);
  const [textRevisions, setTextRevisions] = useState<Record<string, number>>({});
  const [sceneTransferIds, setSceneTransferIds] = useState<string[] | null>(null);
  const [undoDeleteId, setUndoDeleteId] = useState<string | null>(null);
  const [dismissUndo, setDismissUndo] = useState<{ eventIds: string[]; profileId: string; count: number } | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "merged" | "error" | "stale" | "local" | "needs_attention">("saved");
  const [syncMode, setSyncMode] = useState<"probing" | "legacy" | "v2" | "cached" | "unavailable">(ACTIVE_SYNC_ENGINE === "v1" ? "legacy" : "probing");
  const [connectionState, setConnectionState] = useState<ConnectionState>(ACTIVE_SYNC_ENGINE === "v1" ? "online" : "starting");
  const [syncPendingCount, setSyncPendingCount] = useState(0);
  const [syncBusyGroups, setSyncBusyGroups] = useState<Set<string>>(() => new Set());
  const [syncRecoveryItems, setSyncRecoveryItems] = useState<SyncRecoveryItem[]>([]);
  const [syncNotices, setSyncNotices] = useState<SyncNoticeRecord[]>([]);
  const [discardRecoveryId, setDiscardRecoveryId] = useState<string | null>(null);
  const [remoteTextChanges, setRemoteTextChanges] = useState<Set<string>>(() => new Set());
  const [lastServerSync, setLastServerSync] = useState<string | null>(null);
  const [offlineCacheReady, setOfflineCacheReady] = useState(false);
  const [conflicts, setConflicts] = useState<WorkspaceConflictRecord[]>([]);
  const [recoveryIssues, setRecoveryIssues] = useState<RecoveryIssue[]>([]);
  const [recoveryExportItems, setRecoveryExportItems] = useState<Array<{ key: string; raw: string }>>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [anchorRequest, setAnchorRequest] = useState<AnchorRequest | null>(null);
  const [focusedSceneId, setFocusedSceneId] = useState<string | null>(null);
  const [scriptJump, setScriptJump] = useState<ScriptJumpRequest | null>(null);
  const [scriptSearchPages, setScriptSearchPages] = useState<ScriptSearchPage[] | null>(null);
  const [scriptSearchLoading, setScriptSearchLoading] = useState(false);
  const [scriptSearchError, setScriptSearchError] = useState<string | null>(null);
  const [scriptSearchAttempt, setScriptSearchAttempt] = useState(0);
  const syncedStateRef = useRef<WorkspaceState>(defaultState);
  const revisionRef = useRef(0);
  const legacyGenerationRef = useRef<string | null>(null);
  const pendingStateRef = useRef<WorkspaceState | null>(null);
  const pendingMutationIdRef = useRef<string | null>(null);
  const automaticRetryRef = useRef(true);
  const saveInFlightRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const flushPendingRef = useRef<() => Promise<void>>(async () => undefined);
  const syncChannelRef = useRef<BroadcastChannel | null>(null);
  const activeMutationRef = useRef<WorkspaceMutation | null>(null);
  const profileMenuReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const searchToggleRef = useRef<HTMLButtonElement | null>(null);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);
  const searchFromRectRef = useRef<DOMRect | null>(null);
  const searchClosedRectRef = useRef<DOMRect | null>(null);
  const searchMotionRef = useRef<Animation | null>(null);
  const searchReturnFocusRef = useRef<HTMLElement | null>(null);
  const pageJumpButtonRef = useRef<HTMLButtonElement | null>(null);
  const pageNumberInputRef = useRef<HTMLInputElement | null>(null);
  const noteVisibilityReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const postedPendingNoteRef = useRef<PendingNote | null>(null);
  const syncV2ClientRef = useRef<SyncV2Client | null>(null);
  const getSyncV2Client = useCallback(() => syncV2ClientRef.current, []);
  const syncV2VersionsRef = useRef<ProjectionVersions | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);


  const noteFocus = useCallback((discussionId: string) => {
    const focusTimer = window.setTimeout(() => {
      const preferred = selectedCueId ? document.querySelector<HTMLElement>(`.cue-panel [data-discussion-id="${discussionId}"]`) : null;
      (preferred?.getClientRects().length ? preferred : [...document.querySelectorAll<HTMLElement>(`[data-discussion-id="${discussionId}"]`)].find(element => element.getClientRects().length && !element.closest("[hidden]")))?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(focusTimer);
  }, [selectedCueId]);

  useEffect(() => {
    if (!focusedDiscussionId) return;
    return noteFocus(focusedDiscussionId);
  }, [focusedDiscussionId, noteFocus, noteVisibility, view]);

  const setWorkspaceState = useCallback((next: WorkspaceState) => {
    setState((previous) => shareWorkspaceState(previous, next));
  }, []);

  useEffect(() => {
    if (ACTIVE_SYNC_ENGINE === "v1") return;
    let active = true;
    const client = new SyncV2Client({
      onBootstrap: (bootstrap: BootstrapPayload, source) => {
        if (!active) return;
        const next = normalizeWorkspaceScenes(normalizeCueNumbers(bootstrap.state));
        setTextRevisions(Object.fromEntries(bootstrap.textDocuments.map((item) => [item.cueId, item.revision])));
        syncV2VersionsRef.current = bootstrap.versions;
        setSyncNotices(bootstrap.notices ?? []);
        syncedStateRef.current = next;
        revisionRef.current = bootstrap.sequence;
        setWorkspaceState(next);
        setConflicts(openWorkspaceConflicts(next));
        setLoadError(false);
        setLoaded(true);
        if (source === "server") setLastServerSync(bootstrap.serverTime);
      },
      onConnection: (next) => { if (active) setConnectionState(next); },
      onSave: (next: SyncV2SaveState) => {
        if (!active) return;
        setSaveState(next === "sending" ? "saving" : next === "idle" ? "saved" : next);
      },
      // Connection and sync transport details belong in the corner status.
      // Actionable operation results arrive through durable notices or recovery.
      onError: () => undefined,
      onText: (cueId, field, value) => {
        if (!active) return;
        setState((current) => current.cues.some((cue) => cue.id === cueId && cue[field] !== value) ? { ...current, cues: current.cues.map((cue) => cue.id === cueId ? { ...cue, [field]: value } : cue) } : current);
      },
      onPending: (count) => { if (active) setSyncPendingCount(count); },
      onBusyGroups: (groups) => { if (active) setSyncBusyGroups(new Set(groups)); },
      onRecovery: (items) => { setSyncRecoveryItems(items); },
      onDrafts: (items) => {
        if (!active) return;
        const note = items.find((item) => item.kind === "note" || item.key === "note-draft");
        const savedNote = note ? readSavedNoteDraft(note.value) : null;
        if (savedNote) {
          setCommentText((current) => current || savedNote.text);
          setPendingNote((current) => current ?? savedNote.pendingNote);
          setScriptPage(savedNote.pendingNote.anchor.page);
        }
        const reply = items.find((item) => item.kind === "reply" || item.key.startsWith("reply-draft:"));
        if (reply) {
          setReplyText((current) => current || reply.value);
          const targetId = reply.targetId ?? reply.key.slice("reply-draft:".length);
          if (targetId && targetId !== "new") setReplyingToId((current) => current ?? targetId);
        }
        const profile = items.find((item) => item.kind === "profile" || item.key.startsWith("profile-draft:"));
        if (profile) try { setProfileDraft((current) => current ?? JSON.parse(profile.value) as Profile); } catch { /* The raw draft remains copyable. */ }
      },
      onRemoteText: (cueId, field) => { if (active) setRemoteTextChanges((current) => new Set(current).add(`${cueId}:${field}`)); },
      onOfflineCache: (ready) => {
        if (!active) return;
        setOfflineCacheReady(ready);
      },
    });
    syncV2ClientRef.current = client;
    if (desktopMode) window.desktopFlush = () => client.flushDesktop("local");
    void client.start().then((mode) => {
      if (!active) return;
      setSyncMode(mode);
      if (mode === "cached") setLoaded(true);
      if (mode === "unavailable") setLoadError(true);
    });
    return () => {
      active = false;
      syncV2ClientRef.current = null;
      client.stop();
    };
  }, [loadAttempt, setWorkspaceState]);

  useEffect(() => {
    if (syncMode !== "v2") return;
    const client = syncV2ClientRef.current;
    client?.setVisibleTextCue((view === "script" || view === "cues" && cueListPanelOpen) && !anchorRequest ? selectedCueId : null);
    return () => client?.setVisibleTextCue(null);
  }, [anchorRequest, cueListPanelOpen, selectedCueId, syncMode, view]);

  const storeDurableRecovery = useCallback((mutation: DurableRecoveryMutation) => {
    const result = storeRecoveryMutation(mutation);
    if (!result.ok) {
      const raw = JSON.stringify("base" in mutation && "next" in mutation
        ? createWorkspaceRecoveryMutation(mutation.base, mutation.next, mutation.baseRevision, mutation.mutationId)
        : mutation);
      setRecoveryIssues((current) => current.some((issue) => issue.key === "localStorage" && issue.mutationId === mutation.mutationId)
        ? current
        : [...current, { key: "localStorage", mutationId: mutation.mutationId, message: `${result.message}. Download a recovery copy before closing this tab.`, raw }]);
      setRecoveryExportItems((current) => current.some((item) => item.key === `unsaved:${mutation.mutationId}`) ? current : [...current, { key: `unsaved:${mutation.mutationId}`, raw }]);
    }
    return result.ok;
  }, []);

  const setCommentDraft = (value: string) => {
    setCommentText(value);
    if (syncMode === "v2" && pendingNote) void syncV2ClientRef.current?.saveDraft("note-draft", JSON.stringify({ text: value, pendingNote } satisfies SavedNoteDraft), { kind: "note", targetId: pendingNote.kind === "cue" ? pendingNote.cueId : undefined, actorId: active?.id }).catch(() => setConnectionState("storage_blocked"));
  };

  const setReplyDraft = (value: string) => {
    setReplyText(value);
    if (syncMode === "v2") void syncV2ClientRef.current?.saveDraft(`reply-draft:${replyingToId ?? "new"}`, value, { kind: "reply", targetId: replyingToId ?? undefined, actorId: active?.id }).catch(() => setConnectionState("storage_blocked"));
  };

  const cancelReplyDraft = () => {
    const draftKey = replyingToId ? `reply-draft:${replyingToId}` : null;
    setReplyingToId(null);
    setReplyText("");
    if (syncMode === "v2" && draftKey) void syncV2ClientRef.current?.clearDraft(draftKey);
  };

  const flushPending = useCallback(async () => {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    try {
      while (pendingStateRef.current) {
        const outgoing = pendingStateRef.current;
        const mutationId = pendingMutationIdRef.current ?? uid("mutation");
        pendingStateRef.current = null;
        pendingMutationIdRef.current = null;
        const syncedBase = syncedStateRef.current;
        const baseRevision = revisionRef.current;
        const mutation: WorkspaceMutation = { baseRevision, base: syncedBase, next: outgoing, mutationId };
        // Keep the full base/next pair only in local recovery storage. The
        // network mutation contains the fields that changed, so save size
        // stays tied to the edit rather than the accumulated history.
        const mutationBody = JSON.stringify(createWorkspacePatchMutation(syncedBase, outgoing, baseRevision, mutationId));
        storeDurableRecovery(mutation);
        activeMutationRef.current = mutation;
        setSaveState("saving");
        let response: Response;
        try {
          response = await fetchWithTimeout("/api/state", {
            method: "PUT",
            headers: { "content-type": "application/json", ...(legacyGenerationRef.current ? { "x-legacy-generation": legacyGenerationRef.current } : {}) },
            body: mutationBody,
          });
        } catch (error) {
          pendingStateRef.current ??= outgoing;
          pendingMutationIdRef.current ??= mutationId;
          automaticRetryRef.current = true;
          throw error;
        }
        if (!response.ok && response.status !== 409) {
          pendingStateRef.current ??= outgoing;
          pendingMutationIdRef.current ??= mutationId;
          automaticRetryRef.current = response.status === 408 || response.status === 429 || response.status >= 500;
          throw new Error("Workspace save failed");
        }
        let snapshot: WorkspaceSnapshot;
        try {
          snapshot = await decodeSnapshot(response);
        } catch (error) {
          pendingStateRef.current ??= outgoing;
          pendingMutationIdRef.current ??= mutationId;
          automaticRetryRef.current = true;
          throw error;
        }
        const remote = normalizeWorkspaceScenes(snapshot.state);
        if (activeMutationRef.current?.mutationId === mutationId) activeMutationRef.current = null;
        syncedStateRef.current = remote;
        revisionRef.current = snapshot.revision;
        legacyGenerationRef.current = snapshot.legacyGeneration ?? legacyGenerationRef.current;

        if (response.status === 409) {
          const latest = pendingStateRef.current ?? outgoing;
          const merged = mergeWorkspaceStates(syncedBase, latest, remote);
          const rebased = recordWorkspaceConflicts(merged.state, merged.conflicts, undefined, mutationId);
          pendingStateRef.current = rebased;
          // The rejected mutation was never acknowledged. Give the rebased
          // mutation a new id so a later retry cannot be mistaken for it.
          const rebasedMutationId = uid("mutation");
          pendingMutationIdRef.current = rebasedMutationId;
          storeDurableRecovery({ baseRevision: snapshot.revision, base: remote, next: rebased, mutationId: rebasedMutationId });
          setWorkspaceState(rebased);
          setConflicts(openWorkspaceConflicts(rebased));
          continue;
        }
        const queued = pendingStateRef.current;
        if (queued) {
          // `queued` already contains the active edit. Rebase only the later
          // local delta against the acknowledged outgoing snapshot; using the
          // pre-save base would replay the active edit and report a false conflict.
          const base = outgoing;
          const merged = mergeWorkspaceStates(base, queued, remote);
          const queuedMutationId = pendingMutationIdRef.current ?? uid("mutation");
          const rebased = recordWorkspaceConflicts(merged.state, merged.conflicts, undefined, queuedMutationId);
          pendingStateRef.current = rebased;
          pendingMutationIdRef.current = queuedMutationId;
          storeDurableRecovery({ baseRevision: snapshot.revision, base: remote, next: rebased, mutationId: queuedMutationId });
          setWorkspaceState(rebased);
          setConflicts(openWorkspaceConflicts(rebased));
        } else {
          clearRecoveryMutation(mutationId);
          setWorkspaceState(remote);
          setConflicts(openWorkspaceConflicts(remote));
        }
        if (remote.conflicts?.some((conflict) => conflict.status === "open")) {
          setSaveState("merged");
          window.setTimeout(() => setSaveState((current) => current === "merged" ? "saved" : current), 1800);
        } else {
          setSaveState("saved");
        }
        syncChannelRef.current?.postMessage({ revision: snapshot.revision });
      }
    } catch {
      setSaveState("error");
    } finally {
      saveInFlightRef.current = false;
      if (pendingStateRef.current && automaticRetryRef.current) window.setTimeout(() => void flushPendingRef.current(), 1800);
    }
  }, [setWorkspaceState, storeDurableRecovery]);

  const refreshRemote = useCallback(async () => {
    if (refreshInFlightRef.current || saveInFlightRef.current || pendingStateRef.current) return;
    refreshInFlightRef.current = true;
    const requestedRevision = revisionRef.current;
    try {
      const response = await fetchWithTimeout("/api/state", { headers: { "if-none-match": `"workspace-${requestedRevision}"` } });
      if (response.status === 304) {
        legacyGenerationRef.current = response.headers.get("x-legacy-generation") ?? legacyGenerationRef.current;
        if (!pendingStateRef.current && !saveInFlightRef.current) setSaveState("saved");
        return;
      }
      if (!response.ok) throw new Error("Workspace refresh failed");
      const snapshot = await decodeSnapshot(response);
      // The request may have started while the user had no pending work, then
      // become stale while it was in flight. Never apply that response over a
      // save or edit created after the request began.
      if (pendingStateRef.current || saveInFlightRef.current || revisionRef.current !== requestedRevision) return;
      if (snapshot.revision <= revisionRef.current) {
        setSaveState("saved");
        return;
      }
      const remote = normalizeWorkspaceScenes(snapshot.state);
      syncedStateRef.current = remote;
      revisionRef.current = snapshot.revision;
      legacyGenerationRef.current = snapshot.legacyGeneration ?? legacyGenerationRef.current;
      setWorkspaceState(remote);
      setConflicts(openWorkspaceConflicts(remote));
      setSaveState("saved");
    } catch {
      // Keep the last synced workspace visible, but tell the user it may be stale.
      if (!pendingStateRef.current && !saveInFlightRef.current) setSaveState("stale");
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [setWorkspaceState]);

  useEffect(() => {
    flushPendingRef.current = flushPending;
  }, [flushPending]);

  useEffect(() => {
    if (syncMode !== "legacy") return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    fetch("/api/state", {
      cache: "no-store",
      headers: { "if-none-match": '"workspace-bootstrap"' },
      signal: controller.signal,
    })
      .then((res) => res.ok ? decodeSnapshot(res) : Promise.reject(new Error("Workspace load failed")))
      .then(async (initial: WorkspaceSnapshot) => {
        if (cancelled) return;
        legacyGenerationRef.current = initial.legacyGeneration ?? null;
        const recovered = readRecoveryMutations();
        setRecoveryIssues(recovered.issues);
        setRecoveryExportItems(recovered.exportItems);
        let recoverySnapshot = initial;
        const snapshot = await recoverWorkspace(initial, recovered.records.map((record) => record.mutation), async (mutation) => {
          if (cancelled) return { status: 503, snapshot: recoverySnapshot, error: "Recovery was cancelled." };
          try {
            const response = await fetchWithTimeout("/api/state", { method: "PUT", headers: { "content-type": "application/json", ...(legacyGenerationRef.current ? { "x-legacy-generation": legacyGenerationRef.current } : {}) }, body: JSON.stringify(mutation) });
            if (!response.ok && response.status !== 409) {
              let message = "Recovery save failed.";
              try { message = ((await response.clone().json()) as { error?: string }).error ?? message; } catch { /* Keep the actionable default. */ }
              return { status: response.status, snapshot: recoverySnapshot, error: message };
            }
            const nextSnapshot = await decodeSnapshot(response);
            legacyGenerationRef.current = nextSnapshot.legacyGeneration ?? legacyGenerationRef.current;
            recoverySnapshot = nextSnapshot;
            return { status: response.status, snapshot: nextSnapshot };
          } catch {
            return { status: 503, snapshot: recoverySnapshot, error: "The server could not be reached while replaying this edit." };
          }
        }, (id) => clearRecoveryMutation(id, recovered.records.find((record) => record.mutation.mutationId === id)?.keys), (failure) => {
          const record = recovered.records.find((item) => item.mutation.mutationId === failure.mutationId);
          const message = failure.retryable
            ? `${failure.message} The saved edit is still protected and can be retried.`
            : `${failure.message} This record was kept and will not be retried automatically.`;
          if (!failure.retryable) markRecoveryFailure(failure.mutationId, message);
          setRecoveryIssues((current) => [...current, { key: record?.keys[0] ?? "recovery", mutationId: failure.mutationId, message, retryable: failure.retryable }]);
        });
        if (cancelled) return;
        const remote = normalizeWorkspaceScenes(snapshot.state);
        syncedStateRef.current = remote;
        revisionRef.current = snapshot.revision;
        setWorkspaceState(remote);
        setConflicts(openWorkspaceConflicts(remote));
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoadError(true); })
      .finally(() => window.clearTimeout(timeout));
    return () => { cancelled = true; window.clearTimeout(timeout); controller.abort(); };
  }, [loadAttempt, setWorkspaceState, syncMode]);

  useEffect(() => {
    if (!loaded || syncMode !== "legacy") return;
    const refresh = () => void refreshRemote();
    const interval = window.setInterval(refresh, 1500);
    const visibility = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visibility);
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel("lt-workspace-sync");
      channel.onmessage = refresh;
      syncChannelRef.current = channel;
    }
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visibility);
      syncChannelRef.current?.close();
      syncChannelRef.current = null;
    };
  }, [loaded, refreshRemote, syncMode]);

  useEffect(() => {
    if (syncMode !== "legacy") return;
    const hasUnsavedWork = () => !!pendingStateRef.current || !!activeMutationRef.current || saveInFlightRef.current;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const sendPendingMutation = () => {
      const pending = pendingStateRef.current;
      const mutation = activeMutationRef.current ?? (pending ? {
        baseRevision: revisionRef.current,
        base: syncedStateRef.current,
        next: pending,
        mutationId: pendingMutationIdRef.current ?? uid("mutation"),
      } : null);
      if (!mutation) return;
      const body = JSON.stringify(createWorkspacePatchMutation(mutation.base, mutation.next, mutation.baseRevision, mutation.mutationId));
      if (body.length <= 60_000) void fetch("/api/state", { method: "PUT", headers: { "content-type": "application/json", ...(legacyGenerationRef.current ? { "x-legacy-generation": legacyGenerationRef.current } : {}) }, body, keepalive: true });
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    window.addEventListener("pagehide", sendPendingMutation);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      window.removeEventListener("pagehide", sendPendingMutation);
    };
  }, [syncMode]);

  const persist = (next: WorkspaceState) => {
    if (syncMode !== "legacy") return;
    const normalized = normalizeWorkspaceScenes(next);
    setWorkspaceState(normalized);
    pendingStateRef.current = normalized;
    const mutationId = uid("mutation");
    pendingMutationIdRef.current = mutationId;
    storeDurableRecovery({ baseRevision: revisionRef.current, base: syncedStateRef.current, next: normalized, mutationId });
    automaticRetryRef.current = true;
    setSaveState("saving");
    void flushPendingRef.current();
  };

  const dispatchV2 = (action: SyncAction, optimistic?: WorkspaceState) => {
    if (syncMode !== "v2") return false;
    const client = syncV2ClientRef.current;
    if (!client || !activeId) return true;
    void client.dispatch(action, activeId, optimistic ? () => setWorkspaceState(optimistic) : undefined);
    return true;
  };

  const requireEditGate = () => {
    if (syncMode === "legacy") return true;
    if (syncMode === "v2" && syncV2ClientRef.current?.canEdit) return true;
    return false;
  };

  const retrySave = () => {
    if (syncMode === "v2" || syncMode === "cached") {
      setSaveState("saving");
      void syncV2ClientRef.current?.refresh();
      return;
    }
    if (!pendingStateRef.current) return;
    automaticRetryRef.current = true;
    setSaveState("saving");
    void flushPendingRef.current();
  };

  const downloadRecoveryBundle = () => {
    const current = readRecoveryMutations();
    const items = [...current.exportItems, ...recoveryExportItems].filter((item, index, all) => all.findIndex((candidate) => candidate.key === item.key) === index);
    const blob = new Blob([JSON.stringify({ exportedAt: now(), records: items, issues: [...current.issues, ...recoveryIssues] }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "lighting-design-recovery.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadSyncRecovery = (ids?: string[]) => {
    const selected = ids ? syncRecoveryItems.filter((item) => ids.includes(item.id)) : syncRecoveryItems;
    const blob = new Blob([JSON.stringify({ format: "lighting-dashboard-sync-v2-recovery", exportedAt: now(), items: selected }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "lighting-dashboard-sync-v2-recovery.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const clearSyncRecoveryItem = async (item: SyncRecoveryItem) => {
    const client = syncV2ClientRef.current;
    if (!client) throw new Error("Recovery is unavailable. Your saved copy is still on this device.");
    await client.discardRecovery(item.id);
    const matchingNotice = syncNotices.find((notice) => notice.operationId === item.envelope?.operationId);
    if (matchingNotice && active && requireEditGate()) dispatchV2({ type: "acknowledgeNotice", noticeId: matchingNotice.id, profileId: active.id });
  };

  const discardSyncRecovery = async (item: SyncRecoveryItem) => {
    if (discardRecoveryId !== item.id) {
      setDiscardRecoveryId(item.id);
      return;
    }
    await clearSyncRecoveryItem(item);
    setDiscardRecoveryId(null);
  };

  const discardAllSyncRecovery = async (ids: string[]) => {
    const selected = syncRecoveryItems.filter((item) => ids.includes(item.id));
    if (selected.length !== ids.length) throw new Error("Recovery changed. Review the current copies before discarding all.");
    for (const item of selected) await clearSyncRecoveryItem(item);
    setDiscardRecoveryId(null);
  };

  const acknowledgeSyncNotice = (noticeId: string) => {
    if (!active || !requireEditGate()) return;
    dispatchV2({ type: "acknowledgeNotice", noticeId, profileId: active.id });
  };

  const retryRecovery = () => {
    setRecoveryIssues([]);
    setLoaded(false);
    setLoadAttempt((attempt) => attempt + 1);
  };

  const chooseConflict = (conflict: WorkspaceConflictRecord, choice: "remote" | "incoming") => {
    if (!active) return;
    try {
      const next = resolveWorkspaceConflictGroup(state, conflict.id, choice, active.id);
      setConflicts(openWorkspaceConflicts(next));
      persist(next);
    } catch {
      setValidationError("That conflict choice would create an invalid cue assignment. Choose the paired number and status together or keep the team change.");
    }
  };

  const acknowledgeConflict = (conflict: WorkspaceConflictRecord) => {
    if (!active) return;
    const next = acknowledgeWorkspaceConflictGroup(state, conflict.id, active.id);
    setConflicts(openWorkspaceConflicts(next));
    persist(next);
  };

  useLayoutEffect(() => {
    const box = searchBoxRef.current;
    const from = searchFromRectRef.current;
    searchFromRectRef.current = null;
    if (!box || !from) return;
    const to = box.getBoundingClientRect();
    if (!to.width || !to.height) return;
    searchMotionRef.current?.cancel();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const barElement = box.parentElement;
    if (!barElement) return;
    const bar = barElement.getBoundingClientRect();
    const anchoredLeft = parseFloat(getComputedStyle(barElement).paddingLeft);
    const positionAt = (rect: DOMRect) => ({
      left: `${anchoredLeft}px`, top: `${rect.top - bar.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    });
    const motion = box.animate([
      positionAt(from),
      positionAt(searchClosing && searchClosedRectRef.current ? searchClosedRectRef.current : to),
    ], { duration: 220, easing: "cubic-bezier(.2,.75,.25,1)", fill: searchClosing ? "forwards" : "none" });
    searchMotionRef.current = motion;
    if (searchClosing) motion.onfinish = () => { searchMotionRef.current = null; setSearchClosing(false); };
    return () => motion.cancel();
  }, [searchOpen, searchClosing]);

  const openSearch = useCallback(() => {
    if (!searchOpen) {
      searchFromRectRef.current = searchBoxRef.current?.getBoundingClientRect() ?? null;
      if (!searchClosing) searchClosedRectRef.current = searchFromRectRef.current;
    }
    searchReturnFocusRef.current = searchToggleRef.current;
    setPageKeypadOpen(false);
    setNoteVisibilityMenuOpen(false);
    setSearchSelection(0);
    setSearchClosing(false);
    setSearchOpen(true);
    window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".global-search input")?.focus({ preventScroll: true }));
  }, [searchOpen, searchClosing]);

  const closeSearch = useCallback((restoreFocus = false, clearQuery = true) => {
    if (searchOpen) searchFromRectRef.current = searchBoxRef.current?.getBoundingClientRect() ?? null;
    if (clearQuery) setSearch("");
    setSearchSelection(0);
    if (searchOpen) setSearchClosing(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    setSearchOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => searchReturnFocusRef.current?.focus({ preventScroll: true }));
  }, [searchOpen]);

  const toggleSearch = useCallback(() => {
    if (view === "search") {
      document.querySelector<HTMLInputElement>(".full-search-query input")?.focus();
      return;
    }
    if (searchOpen) closeSearch(true);
    else openSearch();
  }, [closeSearch, openSearch, searchOpen, view]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (view === "search") document.querySelector<HTMLInputElement>(".full-search-query input")?.focus();
        else openSearch();
        return;
      }

    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [openSearch, view]);

  useEffect(() => {
    if (!searchOpen) return;
    const dismiss = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.(".global-search")) return;
      closeSearch(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSearch(true);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keydown);
    };
  }, [closeSearch, searchOpen]);

  useEffect(() => {
    if (!pageKeypadOpen) return;
    const dismiss = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.(".page-jump-control")) return;
      setPageKeypadOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPageKeypadOpen(false);
      pageJumpButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keydown);
    };
  }, [pageKeypadOpen]);

  useEffect(() => {
    if (!profileMenuOpen) return;
    const focusTimer = window.setTimeout(() => document.querySelector<HTMLButtonElement>(".profile-menu .profile-options > button")?.focus(), 0);
    const dismiss = (event: Event) => {
      if ((event.target as Element | null)?.closest?.(".profile-switch")) return;
      setProfileMenuOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setProfileMenuOpen(false);
      profileMenuReturnFocusRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keydown);
    };
  }, [profileMenuOpen]);

  useLayoutEffect(() => {
    if (!profileMenuOpen) return;
    const menu = document.querySelector<HTMLElement>(".mobile-profile-switch .profile-menu");
    if (!menu) return;
    const root = document.documentElement;
    const updateZoomPosition = () => {
      if (!window.matchMedia("(max-width: 1024px)").matches) {
        root.style.removeProperty("--mobile-profile-menu-clearance");
        return;
      }
      const bottom = Number.parseFloat(getComputedStyle(menu).bottom) || 58;
      root.style.setProperty("--mobile-profile-menu-clearance", `${Math.ceil(bottom + menu.offsetHeight + 8)}px`);
    };
    const observer = new ResizeObserver(updateZoomPosition);
    observer.observe(menu);
    window.addEventListener("resize", updateZoomPosition);
    window.visualViewport?.addEventListener("resize", updateZoomPosition);
    updateZoomPosition();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateZoomPosition);
      window.visualViewport?.removeEventListener("resize", updateZoomPosition);
      root.style.removeProperty("--mobile-profile-menu-clearance");
    };
  }, [profileMenuOpen]);

  useEffect(() => {
    if (!noteVisibilityMenuOpen) return;
    const focusTimer = window.setTimeout(() => document.querySelector<HTMLButtonElement>(".note-visibility-menu [role=radio]")?.focus(), 0);
    const dismiss = (event: Event) => {
      if ((event.target as Element | null)?.closest?.(".note-visibility-control")) return;
      setNoteVisibilityMenuOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setNoteVisibilityMenuOpen(false);
        noteVisibilityReturnFocusRef.current?.focus({ preventScroll: true });
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const options = [...document.querySelectorAll<HTMLButtonElement>(".note-visibility-menu [role=radio]")];
      const current = options.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keydown);
    };
  }, [noteVisibilityMenuOpen]);

  const active = state.profiles.find((p) => p.id === activeId);
  const selectedCue = state.cues.find((c) => c.id === selectedCueId) ?? null;
  const numberTargetCue = state.cues.find((cue) => cue.id === numberTargetId) ?? null;
  const orderedWorkspaceCues = useMemo(() => orderCuePlacements(state.cues), [state.cues]);
  const profile = (id?: string | null) => id === "mixed" ? { id: "mixed", name: "Mixed ownership", role: "Multiple owners", initials: "↔", color: "#8a929f" } : state.profiles.find((p) => p.id === id);
  const scene = (id: string) => state.scenes.find((s) => s.id === id);
  const currentForYou = useMemo(() => activeId && state.profiles.some((profile) => profile.id === activeId) ? stackInboxEvents(currentInboxEventsForProfile(state, activeId).filter((event) => {
    if (inboxScene !== "all" && !activitySceneIds(event, state).includes(inboxScene)) return false;
    return inboxType === "all" || activityTypeGroup(event) === inboxType;
  }), "current").length : 0, [activeId, inboxScene, inboxType, state]);
  const outOfOrderCueIds = useMemo(() => findOutOfOrderCueIds(state.cues), [state.cues]);
  const openNoteCounts = useMemo(() => cueNoteCounts(state.discussions, noteVisibility), [noteVisibility, state.discussions]);
  const openCount = (cueId: string) => openNoteCounts[cueId] ?? 0;
  const ownersForScenes = (sceneIds: Array<string | undefined>) => [...new Set(sceneIds.flatMap((sceneId) => {
    const ownerId = state.scenes.find((item) => item.id === sceneId)?.ownerId;
    return ownerId ? [ownerId] : [];
  }))];

  const chooseProfile = () => {
    if (!candidateId) return;
    savePreference("lt-active-profile", candidateId);
    setActiveId(candidateId);
  };

  const updateCueById = (cueId: string, patch: Partial<Cue>, activity?: { type: ActivityType; text: string }) => {
    const targetCue = state.cues.find((cue) => cue.id === cueId);
    if (!targetCue || !active) return;
    const cueLimits: Partial<Record<keyof Cue, number>> = { title: FIELD_LIMITS.cueTitle, description: FIELD_LIMITS.cueDescription, technicalNotes: FIELD_LIMITS.technicalNotes };
    const invalid = Object.entries(patch).find(([field, value]) => typeof value === "string" && cueLimits[field as keyof Cue] !== undefined && exceedsLimit(value, cueLimits[field as keyof Cue]!) && value.length >= String(targetCue[field as keyof Cue] ?? "").length);
    if (invalid) {
      setValidationError(`Cue ${invalid[0]} is limited to ${cueLimits[invalid[0] as keyof Cue]} characters. The longer draft was not saved.`);
      return;
    }
    if (typeof patch.number === "number" && state.cues.some((cue) => cue.id !== cueId && cue.number === patch.number)) {
      setValidationError(`${formatCueNumber(patch.number)} is already in use. The current number was kept. Choose a different number.`);
      return;
    }
    if (patch.mode === "implemented" && (!targetCue.number || targetCue.mode === "unassigned")) return;
    if (syncMode === "v2") {
      const textField = (["title", "description", "technicalNotes"] as const).find((field) => typeof patch[field] === "string");
      if (textField) {
        const client = syncV2ClientRef.current;
        if (!client?.canEditTarget(cueId)) {
          // A native input event can still be dispatched at a read-only field.
          // Re-render the controlled value instead of showing text that the
          // closed edit gate did not admit.
          setState((current) => ({ ...current }));
          return;
        }
        setState((current) => ({ ...current, cues: current.cues.map((cue) => cue.id === cueId ? { ...cue, [textField]: patch[textField]! } : cue) }));
        void client.editText(cueId, textField, patch[textField]!, active.id);
        return;
      }
      if (Object.keys(patch).length === 0) {
        void syncV2ClientRef.current?.flushText(cueId, active.id);
        return;
      }
      const versions = syncV2VersionsRef.current?.cues[cueId];
      if (!versions) return;
      const optimistic = { ...state, cues: state.cues.map((cue) => cue.id === cueId ? { ...cue, ...patch } : cue) };
      if (patch.number === null) dispatchV2({ type: "unassignCue", cueId, expectedAssignmentVersion: versions.assignment }, optimistic);
      else if (typeof patch.number === "number") dispatchV2({ type: "setCueNumber", cueId, number: patch.number, expectedAssignmentVersion: versions.assignment }, optimistic);
      else if (patch.mode) dispatchV2({ type: "setCueMode", cueId, mode: patch.mode, expectedAssignmentVersion: versions.assignment }, optimistic);
      else if (typeof patch.blackout === "boolean") dispatchV2({ type: "setBlackout", cueId, blackout: patch.blackout, expectedBlackoutVersion: versions.blackout }, optimistic);
      else return;
      return;
    }
    const next: WorkspaceState = {
      ...state,
      cues: state.cues.map((cue) => cue.id === cueId ? { ...cue, ...patch } : cue),
      history: activity ? [{ id: uid("history"), cueId, sceneId: targetCue.sceneId, targetProfileIds: ownersForScenes([targetCue.sceneId]), actorId: active.id, type: activity.type, text: activity.text, createdAt: now() }, ...state.history] : state.history,
    };
    persist(next);
  };

  const updateCue = (patch: Partial<Cue>, activity?: { type: ActivityType; text: string }) => {
    if (selectedCue) updateCueById(selectedCue.id, patch, activity);
  };

  const handleCollaborativeTextKeyDown = (cueId: string, event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (syncMode !== "v2" || !active || event.key.toLowerCase() !== "z" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    if (!requireEditGate()) return;
    void syncV2ClientRef.current?.undoText(cueId, active.id, event.shiftKey);
  };

  const beginTextComposition = (cueId: string) => {
    if (syncMode === "v2") void syncV2ClientRef.current?.beginComposition(cueId);
  };

  const endTextComposition = (cueId: string, field: "title" | "description" | "technicalNotes", value: string) => {
    if (syncMode === "v2" && active) void syncV2ClientRef.current?.endComposition(cueId, field, value, active.id);
  };

  const markTextPasteBoundary = (cueId: string) => syncV2ClientRef.current?.stopTextCapture(cueId);

  const restoreTextHistory = (cueId: string, historyRevision: number, expectedDocumentRevision: number) => {
    if (!requireEditGate()) return;
    dispatchV2({ type: "restoreTextVersion", cueId, historyRevision, expectedDocumentRevision });
  };

  const preserveRejectedPaste = (cueId: string, field: string, label: string, value: string) => {
    if (!requireEditGate()) return;
    const key = `oversized-paste:${cueId}:${field}:${crypto.randomUUID()}`;
    void syncV2ClientRef.current?.protectDraft(key, value, { targetId: cueId, field }).then(() => setValidationError(syncNotice("N22", { field: label }))).catch(() => setConnectionState("storage_blocked"));
  };
  const clearRemoteTextChange = (cueId: string, field: string) => setRemoteTextChanges((current) => {
    const next = new Set(current);
    next.delete(`${cueId}:${field}`);
    return next;
  });

  const requestDeleteCue = (cueId: string) => { if (requireEditGate()) { setDeleteBusy(false); setDeleteTargetId(cueId); } };

  const confirmDeleteCue = async () => {
    if (!requireEditGate()) return;
    if (!deleteTargetId || !active || deleteBusy) return;
    const cueId = deleteTargetId;
    const next = moveCueToTrash(state, cueId, active.id, now(), uid("history"));
    if (next === state) return;
    const finish = () => {
      setWorkspaceState(next);
      if (selectedCueId === cueId) setSelectedCueId(null);
      setUndoDeleteId(cueId);
      setDeleteTargetId(null);
    };
    if (syncMode !== "v2") {
      persist(next);
      finish();
      return;
    }
    const client = syncV2ClientRef.current;
    const version = syncV2VersionsRef.current?.cues[cueId];
    if (!client || version?.lifecycle === undefined) return;
    setDeleteBusy(true);
    const flushed = await client.flushText(cueId, active.id);
    if (!flushed) {
      setDeleteBusy(false);
      return;
    }
    await client.dispatch({ type: "deleteCue", cueId, expectedLifecycleVersion: version.lifecycle }, active.id, () => {
      finish();
    });
    setDeleteBusy(false);
  };

  const restoreDeletedCue = (cueId: string, openCue = false) => {
    if (!requireEditGate()) return;
    if (!active) return;
    const next = restoreCueFromTrash(state, cueId, active.id, now(), uid("history"));
    if (next === state) return;
    const version = syncV2VersionsRef.current?.cues[cueId];
    if (!dispatchV2({ type: "restoreCue", cueId, expectedLifecycleVersion: version?.lifecycle }, next)) persist(next);
    setUndoDeleteId((current) => current === cueId ? null : current);
    if (openCue) {
      const restored = next.cues.find((cue) => cue.id === cueId);
      if (restored) {
        setScriptPage(restored.page);
        setScriptSceneId(restored.sceneId);
        setSelectedCueId(restored.id);
        setView("script");
      }
    }
  };

  const selectCue = (cueId: string, expand = false, destination: "script" | "cues" = "script", preservePosition = false) => {
    if (preservePosition) preserveScriptPosition(cueId);
    else setScriptJump(null);
    setCueListPanelOpen(destination === "cues");
    cueListPendingFocusRef.current=null;
    cueListReturnFocusRef.current=destination === "cues" ? [...document.querySelectorAll<HTMLButtonElement>(".cue-list-page .table-row-open")].find(button=>button.closest<HTMLElement>("[data-cue-id]")?.dataset.cueId===cueId)??null : null;
    setCuePanelCompact(window.innerWidth < 900 || Boolean(document.querySelector(".formatted-script.layout-overlap")) && !document.querySelector(".script-layout.detail-open"));
    setCuePanelClosing(false);
    setCuePanelExpanded(expand);
    setCueNotesRequest(0);
    const cue = state.cues.find((item) => item.id === cueId);
    if (cue) { setScriptPage(cue.page); setScriptSceneId(cue.sceneId); }
    if (!replyingToId || !replyText.length) {
      setFocusedDiscussionId(null);
      setReplyingToId(null);
      setReplyText("");
    }
    setSelectedCueId(cueId);
    setView(destination);
  };

  const cueNavigation = view === "cues" ? orderedWorkspaceCues.filter(cue => modeFilter === "all" || (modeFilter === "blackout" ? cue.blackout : cue.mode === modeFilter)) : orderedWorkspaceCues;
  const navigateCueCard = (direction: number, expanded: boolean) => {
    const cues = cueNavigation;
    const index = cues.findIndex(cue => cue.id === selectedCueId);
    const target = cues[Math.max(0,Math.min(cues.length-1,index+direction))];
    if (target) selectCue(target.id,expanded,view === "cues" ? "cues" : "script");
  };

  const openScriptPage = (page: number, anchorY?: number) => {
    setFocusedDiscussionId(null);
    setReplyingToId(null);
    setReplyText("");
    setSelectedCueId(null);
    setScriptPage(page);
    setScriptJump({ page, anchorY, key: uid("jump") });
    setView("script");
  };

  const openSceneInScript = (target: Scene) => {
    setScriptSceneId(target.id);
    openScriptPage(target.pageStart, target.startY);
  };

  const showDiscussion = (discussion: Discussion, route = true) => {
    if (noteVisibility === "none" || (noteVisibility === "active" && discussion.resolved)) setNoteVisibility("all");
    if (route) {
      const cue = discussionTargetType(discussion) === "cue" && discussion.cueId ? state.cues.find((item) => item.id === discussion.cueId) : undefined;
      const targetScene = discussionTargetType(discussion) === "scene" && discussion.sceneId ? state.scenes.find((item) => item.id === discussion.sceneId) : undefined;
      if (cue) {
        setScriptPage(cue.page);
        setScriptSceneId(cue.sceneId);
        setSelectedCueId(cue.id);
        setView("script");
      } else if (targetScene) {
        openSceneInScript(targetScene);
      } else {
        openScriptPage(discussion.page ?? 1, discussion.anchorY);
      }
    }
    if (!replyingToId || !replyText.length) {
      setReplyingToId(null);
      setReplyText("");
    }
    if (discussionTargetType(discussion) !== "cue" && !route) setSelectedCueId(null);
    setFocusedDiscussionId(discussion.id);
  };

  const openSceneInList = (sceneId: string) => {
    setFocusedSceneId(sceneId);
    setView("scenes");
  };

  const openCueNotes = (cueId: string) => {
    selectCue(cueId, false);
    setCueNotesRequest((request) => request + 1);
  };

  const preserveScriptPosition = useCallback((preserveCueId?: string) => {
    const frame = document.querySelector<HTMLElement>(".pdf-frame");
    // Formatted reading has its own source-word restoration; hidden views do not resize.
    if (!frame || frame.dataset.readerFormat !== "pdf" || !frame.getClientRects().length) return;
    const readingLine = frame.getBoundingClientRect().top + 84;
    const stages = [...frame.querySelectorAll<HTMLElement>(".pdf-page-stage")];
    const stage = stages.findLast(element => element.getBoundingClientRect().top <= readingLine) ?? stages[0];
    if (!stage) return;
    const bounds = stage.getBoundingClientRect();
    const page = Number(stage.closest<HTMLElement>("[data-page]")?.dataset.page);
    if (page && bounds.height > 0) setScriptJump({ page, anchorY:(readingLine - bounds.top) / bounds.height, key:uid("resize"), preservePosition:true, preserveCueId, preserveTop:frame.scrollTop <= 1 });
  }, []);

  const closeCuePanel = useCallback(() => {
    preserveScriptPosition();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {cueListPendingFocusRef.current=cueListReturnFocusRef.current;cueListReturnFocusRef.current=null;setSelectedCueId(null);setCueListPanelOpen(false);}
    else setCuePanelClosing(true);
    setFocusedDiscussionId(null);
    setReplyingToId(null);
    setReplyText("");
  }, [preserveScriptPosition]);

  const beginAddCue = () => {
    if (!requireEditGate()) return;
    setPendingNote(null);
    setCommentText("");
    setAnchorRequest({ mode: "create", assignNumber: false });
    setView("script");
  };

  const beginAddNote = () => {
    if (!requireEditGate()) return;
    setSelectedCueId(null);
    setPendingNote(null);
    setCommentText("");
    if (syncMode === "v2") void syncV2ClientRef.current?.clearDraft("note-draft");
    setAnchorRequest({ mode: "note" });
    setView("script");
  };

  const placeNote = (target: { type: "cue" | "scene"; id: string } | null, draft: PdfAnchorDraft) => {
    if (!requireEditGate()) return;
    const anchor = { ...draft, anchorY: draft.lineAnchorY ?? draft.anchorY };
    setPendingNote(target?.type === "cue" ? { kind: "cue", cueId: target.id, anchor } : { kind: "script", anchor });
    setAnchorRequest(null);
    setView("script");
  };

  const beginEditAnchor = (cueId: string) => {
    if (!requireEditGate()) return;
    setPendingNote(null);
    setCommentText("");
    const cue = state.cues.find((item) => item.id === cueId);
    if (cue) {setScriptPage(cue.page);setScriptJump({page:cue.page,anchorY:cue.anchorY,key:uid("jump")});}
    setSelectedCueId(cueId);
    setAnchorRequest({ mode: "edit", cueId });
    setView("script");
  };

  const addCue = (draft: PdfAnchorDraft, anchorType: "line" | "phrase") => {
    if (!requireEditGate()) return;
    if (!active) return;
    const assignNumber = anchorRequest?.mode === "create" && anchorRequest.assignNumber;
    const cueNumber = assignNumber ? autoNumberForPlacement(state.cues, { ...draft, anchorOrder: 0 }) : null;
    const page = draft.page;
    const targetScene = sceneAtPosition(state.scenes, page, draft.anchorY);
    const newCue: Cue = {
      id: uid("cue"), number: cueNumber, title: "New lighting cue", description: "", technicalNotes: "", mode: cueNumber === null ? "unassigned" : "planned", blackout: false,
      sceneId: targetScene?.id ?? "scene-01", page, anchorType,
      selectedText: draft.selectedText,
      enclosingLine: draft.enclosingLine,
      anchorX: draft.anchorX,
      anchorY: draft.anchorY,
      anchorOrder: 0, ownerId: active.id,
    };
    const optimistic = { ...state, cues: sortCuesByPosition([...state.cues, newCue]), history: [{ id: uid("history"), cueId: newCue.id, sceneId: newCue.sceneId, targetProfileIds: ownersForScenes([newCue.sceneId]), actorId: active.id, type: "cue_created" as const, text: cueNumber !== null ? `created this cue as ${formatCueNumber(cueNumber)}.` : "created this cue without a cue number.", createdAt: now() }, ...state.history] };
    if (!dispatchV2({ type: "createCue", cue: newCue, assignNumber: !!assignNumber }, optimistic)) persist(optimistic);
    if (assignNumber && cueNumber === null && syncMode !== "v2") setValidationError(NUMBER_SPACE_ERROR);
    setNewCueFocusId(newCue.id);
    setSelectedCueId(newCue.id);
    setScriptPage(page);
    setAnchorRequest(null);
    setView("script");
  };

  const chooseAnchor = (draft: PdfAnchorDraft, anchorType: "line" | "phrase") => {
    if (!requireEditGate()) return;
    if (anchorRequest?.mode === "note") {
      setPendingNote({ kind: "script", anchor: { ...draft, anchorY: draft.lineAnchorY ?? draft.anchorY } });
      setAnchorRequest(null);
      return;
    }
    if (!anchorRequest || anchorRequest.mode === "create") {
      addCue(draft, anchorType);
      return;
    }
    if (!active) return;
    const targetScene = sceneAtPosition(state.scenes, draft.page, draft.anchorY);
    const cueId = anchorRequest.cueId;
    const existingCue = state.cues.find((cue) => cue.id === cueId);
    const movedNumber = existingCue?.number ? autoNumberForPlacement(state.cues.filter((cue) => cue.id !== cueId), { ...draft, anchorOrder: 0 }) : null;
    const movedCues = state.cues.map((cue) => cue.id === cueId ? {
      ...cue,
      number: movedNumber,
      mode: movedNumber === null ? "unassigned" as const : cue.mode,
      page: draft.page,
      sceneId: targetScene?.id ?? cue.sceneId,
      anchorType,
      selectedText: draft.selectedText,
      enclosingLine: draft.enclosingLine,
      anchorX: draft.anchorX,
      anchorY: draft.anchorY,
    } : cue);
    const optimistic: WorkspaceState = {
      ...state,
      cues: sortCuesByPosition(movedCues),
      history: [{ id: uid("history"), cueId, sceneId: targetScene?.id ?? existingCue?.sceneId, sceneIds: [...new Set([existingCue?.sceneId, targetScene?.id].filter((id): id is string => !!id))], targetProfileIds: ownersForScenes([existingCue?.sceneId, targetScene?.id]), actorId: active.id, type: "cue_anchor", text: movedNumber ? `moved this cue to a new script anchor and renumbered it ${formatCueNumber(movedNumber)}.` : "moved this unassigned cue to a new script anchor.", createdAt: now() }, ...state.history],
    };
    const version = syncV2VersionsRef.current?.cues[cueId];
    const position = { sceneId: targetScene?.id ?? existingCue?.sceneId ?? "scene-01", page: draft.page, anchorType, selectedText: draft.selectedText, enclosingLine: draft.enclosingLine, anchorX: draft.anchorX, anchorY: draft.anchorY, anchorOrder: existingCue?.anchorOrder ?? 0 };
    if (!dispatchV2({ type: "moveCue", cueId, position, expectedPositionVersion: version?.position, expectedAssignmentVersion: version?.assignment }, optimistic)) persist(optimistic);
    if (existingCue && existingCue.number !== null && movedNumber === null && syncMode !== "v2") setValidationError(NUMBER_SPACE_ERROR);
    setScriptPage(draft.page);
    setSelectedCueId(cueId);
    setAnchorRequest(null);
  };

  const chooseNoteTarget = (target: { type: "cue" | "scene"; id: string }, draft?: PdfAnchorDraft) => {
    if (!requireEditGate()) return;
    if (anchorRequest?.mode !== "note") return;
    const targetCue = target.type === "cue" ? state.cues.find((cue) => cue.id === target.id) : undefined;
    const targetScene = target.type === "scene" ? state.scenes.find((scene) => scene.id === target.id) : undefined;
    const anchor = draft ? { ...draft, anchorY: draft.lineAnchorY ?? draft.anchorY } : targetCue ? { page: targetCue.page, selectedText: targetCue.selectedText, enclosingLine: targetCue.enclosingLine, anchorX: targetCue.anchorX ?? .08, anchorY: targetCue.anchorY ?? .12 } : targetScene ? { page: targetScene.pageStart, selectedText: "", enclosingLine: targetScene.name, anchorX: .05, anchorY: targetScene.startY } : { page: state.document.pages, selectedText: "", enclosingLine: "Script line", anchorX: .08, anchorY: .12 };
    setPendingNote(targetCue ? { kind: "cue", cueId: targetCue.id, anchor } : { kind: "script", anchor });
    setAnchorRequest(null);
  };

  const postPlacedNote = () => {
    if (!requireEditGate()) return;
    if (!active || !commentText.trim() || !pendingNote) return;
    if (exceedsLimit(commentText.trim(), FIELD_LIMITS.note)) return;
    if (postedPendingNoteRef.current === pendingNote) return;
    postedPendingNoteRef.current = pendingNote;
    const targetCue = pendingNote.kind === "cue" ? state.cues.find((cue) => cue.id === pendingNote.cueId) : undefined;
    if (pendingNote.kind === "cue" && !targetCue) return;
    const anchor = pendingNote.anchor;
    const discussion: Discussion = {
      id: uid("note"), targetType: targetCue ? "cue" : "script", cueId: targetCue?.id,
      sceneId: targetCue?.sceneId ?? sceneAtPosition(state.scenes, anchor.page ?? state.document.pages, anchor.anchorY ?? 0)?.id, page: anchor.page ?? targetCue?.page,
      anchorX: anchor.anchorX, anchorY: anchor.anchorY, selectedText: anchor.selectedText, enclosingLine: anchor.enclosingLine,
      authorId: active.id, content: commentText.trim(), createdAt: now(), resolved: false, replies: [],
    };
    const optimistic: WorkspaceState = { ...state, discussions: [discussion, ...state.discussions], history: [{ id: uid("history"), cueId: discussion.cueId, sceneId: discussion.sceneId, page: discussion.page, anchorY: discussion.anchorY, discussionId: discussion.id, targetProfileIds: ownersForScenes([discussion.sceneId]), actorId: active.id, type: "note_added", text: "added a note.", createdAt: discussion.createdAt }, ...state.history] };
    if (syncMode === "v2") {
      void syncV2ClientRef.current?.dispatch({ type: "addNote", discussion }, active.id, () => {
        setWorkspaceState(optimistic);
        setCommentText("");
        setPendingNote(null);
      }).then((result) => {
        if (result && ["applied", "adjusted", "unchanged"].includes(result.status)) {
          setValidationError(null); postedPendingNoteRef.current = null;
          void syncV2ClientRef.current?.clearDraft("note-draft");
        } else postedPendingNoteRef.current = null;
      });
      return;
    }
    persist(optimistic);
    setCommentText(""); setPendingNote(null); postedPendingNoteRef.current = null;
  };

  const postReply = (discussionId: string) => {
    if (!requireEditGate()) return;
    if (!active || !replyText.trim()) return;
    if (exceedsLimit(replyText.trim(), FIELD_LIMITS.reply)) return;
    const next = addDiscussionReply(state, discussionId, active.id, replyText, now(), uid("reply"), uid("history"));
    if (next === state) return;
    const reply = next.discussions.find((item) => item.id === discussionId)?.replies.at(-1);
    if (!reply) return;
    if (syncMode === "v2") {
      void syncV2ClientRef.current?.dispatch({ type: "addReply", discussionId, reply }, active.id, () => {
        setWorkspaceState(next);
        // Dispatch invokes this only after storing the pending operation. The
        // saved reply can retry without keeping a second copy in the composer.
        void syncV2ClientRef.current?.clearDraft(`reply-draft:${discussionId}`).then(() => {
          setReplyText(""); setReplyingToId(null);
        }).catch(() => setConnectionState("storage_blocked"));
      });
      return;
    }
    persist(next);
    setReplyText(""); setReplyingToId(null);
  };

  // Script-margin and laptop rail actions stay in their note surface. Inbox/search navigation uses its own activity route.
  const replyInlineNote = (discussionId: string) => {
    if (!requireEditGate()) return;
    if (!state.discussions.some((discussion) => discussion.id === discussionId)) return;
    setReplyingToId(discussionId);
    setReplyText("");
    setFocusedDiscussionId(discussionId);
  };

  const beginProfileEdit = (profileToEdit?: Profile) => {
    if (!requireEditGate()) return;
    const draft = profileToEdit ?? {
      id: uid("profile"),
      name: "",
      role: "Lighting Team",
      initials: "",
      color: "#35a7ff",
    };
    setProfileDraft({ ...draft });
  };

  const updateProfileDraft = (draft: Profile | null) => {
    if (draft && !requireEditGate()) return;
    if (!draft && profileDraft && syncMode === "v2") void syncV2ClientRef.current?.clearDraft(`profile-draft:${profileDraft.id}`);
    setProfileDraft(draft);
    if (syncMode === "v2" && draft) void syncV2ClientRef.current?.saveDraft(`profile-draft:${draft.id}`, JSON.stringify(draft), { kind: "profile", targetId: draft.id, actorId: active?.id }).catch(() => setConnectionState("storage_blocked"));
  };

  const commitProfile = () => {
    if (!requireEditGate()) return;
    if (!profileDraft?.name.trim() || !profileDraft.role.trim() || !profileDraft.initials.trim()) return;
    if (exceedsLimit(profileDraft.name.trim(), FIELD_LIMITS.profileName) || exceedsLimit(profileDraft.role.trim(), FIELD_LIMITS.profileRole) || exceedsLimit(profileDraft.initials.trim(), FIELD_LIMITS.profileInitials)) {
      setValidationError(`Profile names and roles are limited to ${FIELD_LIMITS.profileName} and ${FIELD_LIMITS.profileRole} characters; initials are limited to ${FIELD_LIMITS.profileInitials}.`);
      return;
    }
    const next = saveProfile(state, profileDraft);
    const version = syncV2VersionsRef.current?.profiles[profileDraft.id];
    if (syncMode === "v2") {
      void syncV2ClientRef.current?.dispatch({ type: "createOrUpdateProfile", profile: profileDraft, expectedVersion: version }, activeId ?? profileDraft.id, () => setWorkspaceState(next)).then((result) => {
        if (result && ["applied", "unchanged"].includes(result.status)) {
          void syncV2ClientRef.current?.clearDraft(`profile-draft:${profileDraft.id}`);
          setProfileDraft(null);
        }
      });
      return;
    }
    persist(next);
    setProfileDraft(null);
  };

  const toggleResolved = (discussion: Discussion) => {
    if (!requireEditGate()) return;
    if (!active) return;
    const resolved = !discussion.resolved;
    const discussionEventIds = new Set(state.history.filter((event) => event.discussionId === discussion.id).map((event) => event.id));
    const discussionCue = discussion.cueId ? state.cues.find((cue) => cue.id === discussion.cueId) : undefined;
    const discussionSceneId = discussion.sceneId ?? discussionCue?.sceneId;
    const optimistic: WorkspaceState = {
      ...state,
      discussions: state.discussions.map((d) => d.id === discussion.id ? { ...d, resolved, resolvedBy: resolved ? active.id : undefined } : d),
      history: [{ id: uid("history"), cueId: discussion.cueId, discussionId: discussion.id, sceneId: discussionSceneId, page: discussion.page, anchorY: discussion.anchorY, targetProfileIds: [...new Set([discussion.authorId, ...ownersForScenes([discussionSceneId])])], actorId: active.id, type: resolved ? "note_resolved" : "note_reopened", text: `${resolved ? "resolved" : "reopened"} a note.`, createdAt: now() }, ...state.history],
      inboxPins: resolved ? state.inboxPins.filter((pin) => !discussionEventIds.has(pin.eventId)) : state.inboxPins,
    };
    const version = syncV2VersionsRef.current?.discussions[discussion.id];
    if (syncMode === "v2" && version === undefined) return;
    if (!dispatchV2({ type: "setDiscussionResolved", discussionId: discussion.id, resolved, expectedVersion: version ?? 0 }, optimistic)) persist(optimistic);
    if (resolved && focusedDiscussionId === discussion.id) setFocusedDiscussionId(null);
    if (resolved && replyingToId === discussion.id) { setReplyingToId(null); setReplyText(""); }
  };

  const claimSceneGroup = (sceneIds: string[], confirmed = false) => {
    if (!requireEditGate()) return;
    if (!active) return;
    const members = new Set(sceneIds);
    const otherOwners = ownersForScenes(sceneIds).filter((ownerId) => ownerId !== active.id);
    if (!confirmed && otherOwners.length > 0) {
      setSceneTransferIds(sceneIds);
      return;
    }
    const previousOwners = ownersForScenes(sceneIds);
    const optimistic: WorkspaceState = { ...state, scenes: state.scenes.map((scene) => members.has(scene.id) ? { ...scene, ownerId: active.id } : scene), history: [{ id: uid("history"), sceneIds, targetProfileIds: previousOwners, actorId: active.id, type: "scene_owner", text: `claimed ${sceneIds.length === 1 ? "a scene" : `${sceneIds.length} grouped scenes`}.`, createdAt: now() }, ...state.history] };
    const scenes = sceneIds.map((sceneId) => ({ sceneId, ownerId: active.id, expectedVersion: syncV2VersionsRef.current?.scenes[sceneId] ?? 0 }));
    if (!dispatchV2({ type: "setSceneOwners", scenes }, optimistic)) persist(optimistic);
  };

  const unassignSceneGroup = (sceneIds: string[]) => {
    if (!requireEditGate()) return;
    if (!active) return;
    const members = new Set(sceneIds);
    const previousOwners = [...new Set(state.scenes.filter((scene) => members.has(scene.id)).map((scene) => scene.ownerId).filter((id): id is string => !!id))];
    const optimistic: WorkspaceState = { ...state, scenes: state.scenes.map((scene) => members.has(scene.id) ? { ...scene, ownerId: null } : scene), history: [{ id: uid("history"), sceneIds, targetProfileIds: previousOwners, actorId: active.id, type: "scene_owner", text: `unassigned ${sceneIds.length === 1 ? "a scene" : `${sceneIds.length} grouped scenes`}.`, createdAt: now() }, ...state.history] };
    const scenes = sceneIds.map((sceneId) => ({ sceneId, ownerId: null, expectedVersion: syncV2VersionsRef.current?.scenes[sceneId] ?? 0 }));
    if (!dispatchV2({ type: "setSceneOwners", scenes }, optimistic)) persist(optimistic);
  };

  const assignCueNumber = (cueId: string) => {
    if (!requireEditGate()) return;
    const cue = state.cues.find((item) => item.id === cueId);
    if (!active || !cue || cue.number) return;
    const number = autoNumberForPlacement(state.cues, cue);
    if (number === null) { setValidationError(NUMBER_SPACE_ERROR); return; }
    const optimistic: WorkspaceState = {
      ...state,
      cues: state.cues.map((item) => item.id === cueId ? { ...item, number, mode: "planned" } : item),
      history: [{ id: uid("history"), cueId, sceneId: cue.sceneId, targetProfileIds: ownersForScenes([cue.sceneId]), actorId: active.id, type: "cue_number", text: `assigned this cue as ${formatCueNumber(number)}.`, createdAt: now() }, ...state.history],
    };
    const version = syncV2VersionsRef.current?.cues[cueId];
    if (!dispatchV2({ type: "assignNextNumber", cueId, expectedAssignmentVersion: version?.assignment, expectedLifecycleVersion: version?.lifecycle, expectedPositionVersion: version?.position }, optimistic)) persist(optimistic);
  };

  const unassignCueNumber = (cueId: string) => {
    if (!requireEditGate()) return;
    const cue = state.cues.find((item) => item.id === cueId);
    if (!active || !cue?.number) return;
    const optimistic: WorkspaceState = {
      ...state,
      cues: state.cues.map((item) => item.id === cueId ? { ...item, number: null, mode: "unassigned" } : item),
      history: [{ id: uid("history"), cueId, sceneId: cue.sceneId, targetProfileIds: ownersForScenes([cue.sceneId]), actorId: active.id, type: "cue_number", text: `removed cue number ${formatCueNumber(cue.number)}.`, createdAt: now() }, ...state.history],
    };
    const version = syncV2VersionsRef.current?.cues[cueId];
    if (!dispatchV2({ type: "unassignCue", cueId, expectedAssignmentVersion: version?.assignment }, optimistic)) persist(optimistic);
  };

  const assignAllCueNumbers = (sceneIds?: string[]) => {
    if (!requireEditGate()) return;
    if (!active) return;
    const unassigned = orderCuePlacements(state.cues.filter((cue) => !cue.number && (!sceneIds || sceneIds.includes(sceneAtPosition(state.scenes, cue.page, cue.anchorY ?? 0)?.id ?? ""))));
    if (unassigned.length === 0) return;
    if (unassigned.length > 500) { setValidationError("Assign up to 500 cue numbers at a time. Choose a smaller scene group."); return; }
    const plan = planCueNumberAssignments(state.cues, new Set(unassigned.map((cue) => cue.id)));
    if (plan.failedCueId) {
      const cue = state.cues.find((item) => item.id === plan.failedCueId)!;
      setValidationError(`Could not number “${cue.title || cue.id}” on page ${scriptPageNumber(cue.page)}. No free number fits in script order within three decimal places. No cue numbers were changed.`);
      return;
    }
    const optimistic: WorkspaceState = {
      ...state,
      cues: plan.cues,
      history: [{ id: uid("history"), sceneIds: [...new Set(unassigned.map((cue) => cue.sceneId))], targetProfileIds: ownersForScenes(unassigned.map((cue) => cue.sceneId)), actorId: active.id, type: "cue_number", text: `assigned ${unassigned.length} unnumbered cues in script order.`, createdAt: now() }, ...state.history],
    };
    const selected = unassigned.map((cue) => { const version = syncV2VersionsRef.current?.cues[cue.id]; return { cueId: cue.id, expectedAssignmentVersion: version?.assignment ?? 0, expectedLifecycleVersion: version?.lifecycle ?? 0, expectedPositionVersion: version?.position ?? 0 }; });
    if (!dispatchV2({ type: "assignCueNumbers", cues: selected }, optimistic)) persist(optimistic);
  };

  const dismissActivities = (eventIds: string[]) => {
    if (!requireEditGate()) return;
    if (!active || eventIds.length === 0) return;
    const existing = new Set(state.inboxReads.filter((receipt) => receipt.profileId === active.id).map((receipt) => receipt.eventId));
    const dismissed = eventIds.filter((eventId) => !existing.has(eventId));
    if (dismissed.length === 0) return;
    const readAt = now();
    const receipts = dismissed.map((eventId) => ({ id: `${active.id}:${eventId}`, eventId, profileId: active.id, readAt }));
    const optimistic = { ...state, inboxReads: [...state.inboxReads, ...receipts] };
    if (!dispatchV2({ type: "setInboxRead", eventIds: dismissed, profileId: active.id, read: true }, optimistic)) persist(optimistic);
    setDismissUndo({ eventIds: dismissed, profileId: active.id, count: dismissed.length });
  };

  const undoDismissActivities = () => {
    if (!requireEditGate()) return;
    if (!dismissUndo) return;
    const eventIds = new Set(dismissUndo.eventIds);
    const matches = (receipt: WorkspaceState["inboxReads"][number]) => receipt.profileId === dismissUndo.profileId && eventIds.has(receipt.eventId);
    const restoredEventIds = state.inboxReads.filter(matches).map((receipt) => receipt.eventId);
    if (!restoredEventIds.length) { setDismissUndo(null); return; }
    const optimistic = { ...state, inboxReads: state.inboxReads.filter((receipt) => !matches(receipt)) };
    if (syncMode === "v2") {
      void syncV2ClientRef.current?.dispatch({ type: "setInboxRead", eventIds: restoredEventIds, profileId: dismissUndo.profileId, read: false }, dismissUndo.profileId, () => setWorkspaceState(optimistic))
        .then((result) => { if (result && ["applied", "unchanged"].includes(result.status)) setDismissUndo(null); });
      return;
    }
    persist(optimistic);
    setDismissUndo(null);
  };

  const toggleActivityPins = (events: HistoryEvent[]) => {
    if (!requireEditGate()) return;
    if (!active || events.length === 0) return;
    const eventIds = new Set(events.map((event) => event.id));
    const anyPinned = events.some((event) => isActivityPinned(event, active.id, state));
    const existingEventIds = new Set(state.inboxPins.filter((pin) => pin.profileId === active.id).map((pin) => pin.eventId));
    const optimistic: WorkspaceState = {
      ...state,
      inboxPins: anyPinned
        ? state.inboxPins.filter((pin) => pin.profileId !== active.id || !eventIds.has(pin.eventId))
        : [...state.inboxPins, ...events.filter((event) => !existingEventIds.has(event.id)).map((event) => ({ id: `${active.id}:${event.id}`, eventId: event.id, profileId: active.id, pinnedAt: now() }))],
    };
    if (!dispatchV2({ type: "setInboxPinned", eventIds: [...eventIds], profileId: active.id, pinned: !anyPinned }, optimistic)) persist(optimistic);
  };

  const openActivity = (event: HistoryEvent) => {
    const deleted = deletedCueForActivity(event, state);
    if (deleted) { setTrashFocusId(deleted.id); setTrashOpen(true); return; }
    const discussion = event.discussionId ? state.discussions.find((item) => item.id === event.discussionId) : undefined;
    if (discussion) {
      showDiscussion(discussion);
      return;
    }
    if (event.cueId && state.cues.some((cue) => cue.id === event.cueId)) {
      selectCue(event.cueId);
    } else {
      const targetSceneId = activitySceneIds(event, state)[0];
      const targetScene = state.scenes.find((item) => item.id === targetSceneId);
      if (event.page) openScriptPage(event.page, event.anchorY);
      else if (targetScene) openSceneInScript(targetScene);
    }
  };

  useEffect(() => {
    if (!loaded || scriptSearchPages) return;
    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      setScriptSearchError(null);
      setScriptSearchLoading(true);
      loadScriptSearchPages(FIRST_SCRIPT_PDF_PAGE, state.document.pages)
        .then((pages) => { if (!cancelled) { setScriptSearchPages(pages); setScriptSearchError(null); } })
        .catch(() => { if (!cancelled) setScriptSearchError("Script text could not be indexed."); })
        .finally(() => { if (!cancelled) setScriptSearchLoading(false); });
    };
    const idleWindow = window as typeof window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const idleId = idleWindow.requestIdleCallback?.(start, { timeout: 800 });
    const timer = idleId === undefined ? window.setTimeout(start, 150) : undefined;
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); if (idleId !== undefined) idleWindow.cancelIdleCallback?.(idleId); };
  }, [loaded, scriptSearchAttempt, scriptSearchPages, state.document.pages]);

  const searchResults = useMemo<SearchResult[]>(() => searchWorkspace(state, scriptSearchPages ?? [], search), [scriptSearchPages, search, state]);
  const quickSearchResults = useMemo(() => limitQuickSearchResults(searchResults), [searchResults]);

  const filteredSearchResults = useMemo(() => filterWorkspaceSearchResults(searchResults, state, {
    kind: searchTypeFilter,
    personId: searchPersonFilter,
    sceneId: searchSceneFilter,
  }), [searchPersonFilter, searchResults, searchSceneFilter, searchTypeFilter, state]);
  const pagedSearchResults = useMemo(() => paginateWorkspaceSearchResults(filteredSearchResults, searchPage, 20), [filteredSearchResults, searchPage]);
  const updateSearch = (value: string) => { setSearch(value); setSearchPage(1); setSearchSelection(0); };

  const openSearchResult = (result: SearchResult, clearQuery = true) => {
    if (clearQuery) setSearch("");
    setSearchOpen(false);
    if (result.kind === "cue") selectCue(result.cue.id);
    else if (result.kind === "discussion") {
      showDiscussion(result.discussion);
    }
    else if (result.kind === "scene") openSceneInScript(result.scene);
    else openScriptPage(result.page);
  };

  const retryScriptSearch = () => {
    setScriptSearchPages(null);
    setScriptSearchError(null);
    setScriptSearchAttempt((attempt) => attempt + 1);
  };

  const handleQuickSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setSearchSelection((current) => Math.max(0, Math.min(quickSearchResults.length - 1, current + direction)));
      return;
    }
    if (event.key === "Enter" && quickSearchResults.length > 0) {
      event.preventDefault();
      openSearchResult(quickSearchResults[Math.min(searchSelection, quickSearchResults.length - 1)]);
    }
  };
  const openFullSearch = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    closeSearch(false, false);
    setSearchPage(1);
    setView("search");
  };
  const noteVisibilityLabel = noteVisibility === "none" ? "OFF" : noteVisibility === "active" ? "ACTIVE" : "ALL";
  const noteVisibilityOptions: Array<{ value: NoteVisibility; label: string; description: string }> = [
    { value: "none", label: "NOTES · OFF", description: "Hide saved notes; keep drafts visible" },
    { value: "active", label: "NOTES · ACTIVE", description: "Show open notes" },
    { value: "all", label: "NOTES · ALL", description: "Show open and resolved notes" },
  ];
  const recoveryOperationIds = new Set(syncRecoveryItems.map((item) => item.envelope?.operationId).filter((operationId): operationId is string => !!operationId));
  const recoveryControlGroups = new Set(syncRecoveryItems.flatMap(recoveryItemGroups));
  const syncControlGroups = new Set([...syncBusyGroups, ...recoveryControlGroups]);
  const visibleSyncNotices = syncNotices.filter((notice) => (!notice.operationId || !recoveryOperationIds.has(notice.operationId)) && (!notice.profileId || notice.profileId === active?.id) && operationNeedsAttention({ status: notice.status ?? "adjusted", code: notice.code, message: notice.message, outcome: notice.outcome }));
  const savedClock = lastServerSync ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(lastServerSync)) : "the last confirmed sync";
  const syncHasProblem = connectionState === "storage_blocked" || connectionState === "target_blocked" || connectionState === "upgrade_required" || syncRecoveryItems.length > 0 || saveState === "needs_attention" || saveState === "error";
  const syncIsWaiting = !syncHasProblem && (connectionState !== "online" || syncPendingCount > 0 || ["local", "saving", "merged"].includes(saveState));
  const syncStatus = syncHasProblem ? "problem" : syncIsWaiting ? "waiting" : "saved";
  const syncLabel = syncStatus === "saved" ? "Saved"
    : syncStatus === "waiting" ? `Waiting${syncPendingCount ? ` · ${syncPendingCount} change${syncPendingCount === 1 ? "" : "s"}` : ""}`
    : connectionState === "upgrade_required" ? "Problem · Refresh to update"
    : connectionState === "storage_blocked" ? "Problem · Unsaved text at risk"
    : syncRecoveryItems.length > 0 ? `${syncRecoveryItems.length} saved change${syncRecoveryItems.length === 1 ? "" : "s"} need${syncRecoveryItems.length === 1 ? "s" : ""} review`
    : connectionState === "target_blocked" ? "Problem · Review saved change"
    : "Problem · Try again";
  const syncDetail = connectionState === "offline" ? syncNotice("N02")
    : connectionState === "uncertain" ? syncNotice("N03", { time: savedClock })
    : connectionState === "checking" || connectionState === "starting" ? syncNotice("N01")
    : connectionState === "recovering" ? syncNotice("N05")
    : connectionState === "maintenance" ? syncNotice("N25")
    : connectionState === "storage_blocked" ? syncNotice("N11")
    : connectionState === "upgrade_required" ? "Refresh this page to load the current app version."
    : syncLabel;
  const inboxCount = currentForYou + Number(syncHasProblem);
  const atRiskDrafts = [...(commentText ? [{ label: "Note draft", value: commentText }] : []), ...(replyText ? [{ label: "Reply draft", value: replyText }] : []), ...(profileDraft ? [{ label: "Profile draft", value: JSON.stringify(profileDraft, null, 2) }] : [])];
  const inboxProblem = syncHasProblem && syncRecoveryItems.length === 0 ? {
    label: syncLabel,
    detail: syncDetail,
    actionLabel: connectionState === "upgrade_required" ? "Refresh app" : "Try again",
    onAction: connectionState === "upgrade_required" ? () => window.location.reload() : retrySave,
    drafts: atRiskDrafts,
  } : null;
  const handleSyncProblem = () => {
    setInboxScope("for-you");
    setView("inbox");
    window.requestAnimationFrame(() => {
      const card = document.getElementById("inbox-recovery-card") ?? document.getElementById("inbox-sync-problem-card");
      card?.scrollIntoView({ block: "center" });
      card?.focus({ preventScroll: true });
    });
  };
  const syncWriteBlocked = syncMode === "cached" || syncMode === "unavailable" || syncMode === "v2" && connectionState !== "online";
  const selectedCueRecoveryItems = selectedCue ? syncRecoveryItems.filter((item) => item.targetId === selectedCue.id) : [];
  const selectedCueRecoveryGroups = new Set(selectedCueRecoveryItems.flatMap(recoveryItemGroups));
  const selectedCueTargetRecoveryBlocked = selectedCueRecoveryItems.some((item) => recoveryItemGroups(item).length === 0);
  const selectedCueRecoveryBlocked = selectedCueRecoveryItems.length > 0;
  const selectedCueTextBusy = !!selectedCue && syncBusyGroups.has(`cue:${selectedCue.id}:text`);
  const selectedCueTextRecoveryBlocked = !!selectedCue && (selectedCueTargetRecoveryBlocked || selectedCueRecoveryGroups.has(`cue:${selectedCue.id}:text`));
  const selectedCueWriteBlocked = syncWriteBlocked || selectedCueTextRecoveryBlocked || selectedCueTextBusy;
  const selectedCueBusyGroups = selectedCue ? new Set([...syncControlGroups].filter((group) => group.startsWith(`cue:${selectedCue.id}:`))) : new Set<string>();
  const selectedCueSaving = !!selectedCue && [...syncBusyGroups].some((group) => group.startsWith(`cue:${selectedCue.id}:`));
  const commitPageJump = (value: string) => {
    const requestedPage = Number.parseInt(value, 10);
    const page = Number.isFinite(requestedPage) ? Math.max(1, Math.min(scriptPageCount(state.document.pages), requestedPage)) : scriptPageNumber(scriptPage);
    openScriptPage(pdfPageNumber(page));
  };
  const openPageKeypad = () => {
    closeSearch(false);
    setNoteVisibilityMenuOpen(false);
    setPageDraft("");
    setPageKeypadOpen((open) => !open);
    if (!pageKeypadOpen) window.requestAnimationFrame(() => pageNumberInputRef.current?.focus({ preventScroll: true }));
  };
  const addPageDigit = (digit: string) => {
    setPageDraft((current) => `${current}${digit}`.replace(/^0+(?=\d)/, "").slice(0, String(scriptPageCount(state.document.pages)).length));
    pageNumberInputRef.current?.focus({ preventScroll: true });
  };
  const submitPageKeypad = () => {
    commitPageJump(pageDraft);
    setPageKeypadOpen(false);
    pageJumpButtonRef.current?.focus();
  };

  if (!loaded) return loadError
    ? <main className="loading-screen load-error">{preferenceStorageUnavailable && <PreferenceStorageNotice editingPaused />}<span>{syncMode === "unavailable" ? syncNotice("N27") : "Workspace connection failed"}</span><small>Your shared data was not replaced with demo data.</small><button onClick={() => { setLoadError(false); setLoadAttempt((attempt) => attempt + 1); }}>Retry connection</button></main>
    : <main className="loading-screen"><span className="loader-square" /> Loading production workspace</main>;

  if (!active) {
    return (
      <main className="profile-screen">
        {preferenceStorageUnavailable && <PreferenceStorageNotice editingPaused={syncWriteBlocked} />}
        <div className="profile-header"><span className="eyebrow">LIGHTING DESIGN</span><h1>Lighting design workspace</h1><p>Select your profile for cue history, comments, and scene ownership.</p><button className="primary-button profile-enter" disabled={!candidateId} onClick={chooseProfile}>Enter workspace <span>→</span></button></div>
        <div className="profile-grid">
          {state.profiles.map((p) => <button key={p.id} className={`profile-tile ${candidateId === p.id ? "active" : ""}`} style={{ "--profile": p.color } as React.CSSProperties} onClick={() => setCandidateId(p.id)}><span className="profile-color" style={{ background: p.color }} /><ProfileMark profile={p} /><span><strong>{p.name}</strong><small>{p.role}</small></span><span className="select-indicator">{candidateId === p.id ? "SELECTED" : "SELECT"}</span></button>)}
        </div>
        <div className="profile-footer"><span>This identifies contributions; it is not authentication.</span></div>
      </main>
    );
  }

  return (
    <main className={`app-shell ${syncWriteBlocked ? "sync-write-blocked" : ""}`} data-script-active={view === "script" || undefined} data-sync-mode={syncMode} data-connection-state={connectionState} data-offline-cache-ready={offlineCacheReady ? "true" : "false"}>
      <header className={`topbar ${view === "script" ? "script-active" : ""} ${searchOpen || searchClosing ? "search-expanded" : ""} ${view === "search" ? "full-search-active" : ""}`}>
        <div ref={searchBoxRef} className={`global-search topbar-control ${searchOpen || searchClosing ? "search-open" : ""}`}>
          <button ref={searchToggleRef} type="button" className="search-toggle" aria-label={searchOpen ? "Close workspace search" : view === "search" ? "Focus full search" : "Open workspace search"} aria-expanded={searchOpen} onClick={toggleSearch}><span className="search-glyph" aria-hidden="true" /></button>
          <input aria-label="Search workspace" aria-activedescendant={searchOpen && quickSearchResults.length ? `quick-search-result-${Math.min(searchSelection, quickSearchResults.length - 1)}` : undefined} placeholder="Search cues, pages, scenes, notes…" value={search} onFocus={() => { if (view !== "search" && !searchOpen) openSearch(); }} onChange={(event) => updateSearch(event.target.value)} onKeyDown={handleQuickSearchKeyDown} />
          <kbd>{searchShortcut}</kbd>
          {searchOpen && view !== "search" && search.trim() && <div className="search-results">
            <div className="search-preview-groups" role="listbox" aria-label="Ranked search results">{quickSearchResults.map((result, index) => <SearchResultRow id={`quick-search-result-${index}`} selected={index === Math.min(searchSelection, quickSearchResults.length - 1)} key={searchResultKey(result)} result={result} onOpen={() => openSearchResult(result)} />)}
            {scriptSearchLoading && <p>Indexing script text…</p>}
            {scriptSearchError && <p className="search-index-error"><span>{scriptSearchError}</span><button type="button" onClick={retryScriptSearch}>Retry</button></p>}
            {!scriptSearchLoading && !scriptSearchError && searchResults.length === 0 && <p>No matching cues, notes, scenes, or script text.</p>}</div>
            <button type="button" className="search-more-results" onClick={openFullSearch}>More Results <span>→</span></button>
          </div>}
        </div>
        <div className="script-topbar-actions"><div className="page-jump-control"><button ref={pageJumpButtonRef} type="button" className="topbar-page-jump topbar-control" aria-haspopup="dialog" aria-expanded={pageKeypadOpen} onClick={openPageKeypad}><span>PAGE</span><b>{scriptPageNumber(scriptPage)}</b></button>{pageKeypadOpen && <div className="page-keypad" role="dialog" aria-label="Jump to a script page"><input ref={pageNumberInputRef} aria-label="Page number" inputMode="numeric" pattern="[0-9]*" value={pageDraft} placeholder={String(scriptPageNumber(scriptPage))} onChange={(event) => setPageDraft(event.target.value.replace(/\D/g, "").slice(0, String(scriptPageCount(state.document.pages)).length))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitPageKeypad(); } }} /><div>{["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => <button type="button" key={digit} onClick={() => addPageDigit(digit)}>{digit}</button>)}<button type="button" className="keypad-clear" onClick={() => setPageDraft("")}>Clear</button><button type="button" onClick={() => addPageDigit("0")}>0</button><button type="button" aria-label="Backspace" onClick={() => setPageDraft((current) => current.slice(0, -1))}>⌫</button></div><button type="button" className="keypad-go" onClick={submitPageKeypad}>Go to page</button></div>}</div><div className="note-visibility-control"><button ref={noteVisibilityReturnFocusRef} className={`show-resolved-notes topbar-control note-visibility-${noteVisibility}`} aria-haspopup="menu" aria-expanded={noteVisibilityMenuOpen} aria-controls="note-visibility-menu" aria-label={`Note visibility: ${noteVisibilityLabel}. Show resolved notes when set to All.`} title={`Notes: ${noteVisibilityLabel}`} onClick={() => setNoteVisibilityMenuOpen((open) => !open)}><span>NOTES</span><span>{noteVisibilityLabel}</span></button>{noteVisibilityMenuOpen && <div id="note-visibility-menu" className="note-visibility-menu" role="radiogroup" aria-label="Note visibility"><span>SHOW NOTES</span>{noteVisibilityOptions.map((option) => <button key={option.value} type="button" role="radio" aria-checked={noteVisibility === option.value} tabIndex={noteVisibility === option.value ? 0 : -1} className={noteVisibility === option.value ? "active" : ""} onClick={() => { setNoteVisibility(option.value); setNoteVisibilityMenuOpen(false); window.requestAnimationFrame(() => noteVisibilityReturnFocusRef.current?.focus({ preventScroll: true })); }}><b>{option.label}</b><small>{option.description}</small></button>)}</div>}</div>{view === "script" && <><button className={`topbar-add-cue topbar-control ${anchorRequest?.mode === "create" ? "active" : ""}`} aria-label="New cue" title="New cue" aria-pressed={anchorRequest?.mode === "create"} onClick={beginAddCue}><span className="creation-label">＋ Cue</span><CueIcon className="creation-symbol" /></button><button className={`topbar-add-note topbar-control ${anchorRequest?.mode === "note" ? "active" : ""}`} aria-label="New note" title="New note" aria-pressed={anchorRequest?.mode === "note"} onClick={beginAddNote}><span className="creation-label">＋ Note</span><svg className="creation-symbol" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 3h14v12l-6 6H5z" /><path d="M13 21v-6h6M8 7h8M8 11h6" /></svg></button></>}</div>
        {desktopMode ? <ShowMenu status={syncStatus} onProblem={handleSyncProblem} /> : syncStatus === "problem" ? <button className="sync-state problem sync-retry" aria-label={syncLabel} title={syncDetail} onClick={handleSyncProblem}><span className="sync-dot" aria-hidden="true" />Problem</button> : <span className={`sync-state ${syncStatus}`} aria-label={syncLabel} title={syncDetail}><span className="sync-dot" aria-hidden="true" />{syncStatus === "waiting" ? `Waiting${syncPendingCount ? ` (${syncPendingCount})` : ""}` : "Saved"}</span>}
      </header>

      {preferenceStorageUnavailable && <PreferenceStorageNotice editingPaused={syncWriteBlocked} />}
      {qaTesting && qaRedTargets && <QaRedFaultRunner ready={() => Boolean(active && syncMode === "v2" && qaRedTargets.every((target) => syncV2VersionsRef.current?.cues[target.cueId] && state.cues.some((cue) => cue.id === target.cueId)))} run={async () => {
        const client = syncV2ClientRef.current;
        const actorId = active?.id;
        if (!client || !actorId) throw new Error("Select a profile to run QA faults.");
        const waitForCue = async (cueId: string) => {
          const deadline = Date.now() + 20_000;
          while (!client.canEditTarget(cueId) && Date.now() < deadline) {
            await client.refresh();
            if (client.canEditTarget(cueId)) break;
            await new Promise((resolve) => window.setTimeout(resolve, 250));
          }
          if (!client.canEditTarget(cueId)) throw new Error(`QA cue ${cueId} did not become ready. Its fault was not started.`);
        };
        window.history.replaceState(null, "", window.location.pathname);
        // Prepare every text document before the first injected fault starts a sync refresh.
        for (const target of qaRedTargets.filter((item) => item.kind === "text")) {
          const cue = state.cues.find((item) => item.id === target.cueId);
          if (!cue) throw new Error(`QA cue ${target.cueId} is missing.`);
          await waitForCue(target.cueId);
          if (!await client.editText(target.cueId, "title", cue.title, actorId)) throw new Error(`Could not prepare text for QA cue ${target.cueId}. Its fault was not started.`);
        }
        for (const target of qaRedTargets) {
          const cue = state.cues.find((item) => item.id === target.cueId);
          const version = syncV2VersionsRef.current?.cues[target.cueId];
          if (!cue || !version) throw new Error(`QA cue ${target.cueId} is missing.`);
          await waitForCue(target.cueId);
          if (target.kind === "structured") {
            const result = await client.dispatch({ type: "setBlackout", cueId: target.cueId, blackout: !cue.blackout, expectedBlackoutVersion: version.blackout }, actorId);
            if (result?.code !== "qa_d1_fault") throw new Error(`The D1 fault did not produce a red warning for ${target.cueId}: ${result?.code ?? result?.status ?? "no result"}.`);
          } else {
            if (!await client.editText(target.cueId, "title", `${cue.title} [QA fault]`, actorId)) throw new Error(`Could not edit QA cue ${target.cueId}. Its fault was not started.`);
            await client.flushText(target.cueId, actorId);
          }
        }
        setQaRedTargets(null);
      }} />}

      {syncMode !== "v2" && <ConflictNotice conflicts={conflicts} state={state} active={active} onChoose={chooseConflict} onAcknowledge={acknowledgeConflict} />}
      {(visibleSyncNotices.length > 0 || syncMode !== "v2" && recoveryIssues.length > 0 || validationError) && <div className="workspace-recovery-stack">
        {visibleSyncNotices.map((notice) => { const cue = notice.targetId ? state.cues.find((item) => item.id === notice.targetId) ?? state.deletedCues.find((item) => item.id === notice.targetId)?.cue : undefined; const message = operationNotice({ status: notice.status ?? "adjusted", code: notice.code, message: notice.message, outcome: notice.outcome }, cue?.title || formatCueNumber(cue?.number, "This cue")) ?? notice.message ?? "This change was not saved."; const title = notice.code === "protocol_mismatch" ? "Refresh to update" : notice.code === "access_unavailable" ? "Access unavailable" : notice.code === "restore_preview_stale" ? "Review the latest version" : notice.code === "number_precision_exhausted" ? "Cue left unnumbered" : notice.code === "number_unavailable" ? "Number could not be assigned" : "Change was not saved"; const actionLabel = notice.code === "protocol_mismatch" ? "Refresh" : notice.code === "access_unavailable" ? "Try again" : "Dismiss"; const act = () => { if (notice.code === "protocol_mismatch") window.location.reload(); else if (notice.code === "access_unavailable") retrySave(); else acknowledgeSyncNotice(notice.id); }; return <aside className="workspace-recovery-warning sync-durable-notices" role="alert" key={notice.id}><strong>{title}</strong><p>{message}</p><button type="button" disabled={notice.code !== "protocol_mismatch" && notice.code !== "access_unavailable" && syncWriteBlocked} onClick={act}>{actionLabel}</button></aside>; })}
        {(syncMode !== "v2" && recoveryIssues.length > 0 || validationError) && <aside className="workspace-recovery-warning" role="alert">
          <strong>{validationError?.includes("too long") || validationError?.includes("limited") ? "Shorten this text" : recoveryIssues.length > 0 ? "Unsaved text at risk" : validationError === NUMBER_SPACE_ERROR ? "Cue left unnumbered" : "Change was not saved"}</strong>
          {validationError && <p>{validationError}</p>}
          {syncMode !== "v2" && recoveryIssues.length > 0 && <p>Your browser could not restore {recoveryIssues.length === 1 ? "one older edit" : `${recoveryIssues.length} older edits`}. Download a copy before choosing the server version.</p>}
          {syncMode !== "v2" && recoveryIssues.length > 0 && <div><button type="button" onClick={downloadRecoveryBundle}>Download recovery copy</button>{recoveryIssues.some((issue) => issue.retryable) && <button type="button" onClick={retryRecovery}>Try again</button>}<button type="button" onClick={() => setRecoveryIssues([])}>Use server version</button></div>}
          {validationError && <button type="button" onClick={() => setValidationError(null)}>Dismiss</button>}
        </aside>}
      </div>}
      <aside className="main-nav">
        <div className="nav-items">{nav.filter(item => !desktopMode || item.id !== "inbox").map((item) => <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={`${view === item.id ? "active " : ""}${item.id === "inbox" && syncHasProblem ? "recovery-alert" : ""}`.trim()} onClick={() => setView(item.id)}><span>{item.glyph}</span>{item.label}{item.id === "inbox" && inboxCount > 0 && <b>{inboxCount}</b>}</button>)}</div>
        <div className="nav-bottom">
          {desktopMode && <button className="desktop-settings" aria-label="Settings" title="Settings" onClick={() => setProfileSettingsOpen(true)}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="m9 3-.5 2a7.5 7.5 0 0 0-2 1.2l-2-.6-2 3.4 1.5 1.4a8 8 0 0 0 0 2.4L2.5 14l2 3.4 2-.6a7.5 7.5 0 0 0 2 1.2l.5 2h4l.5-2a7.5 7.5 0 0 0 2-1.2l2 .6 2-3.4-1.5-1.2a8 8 0 0 0 0-2.4L20 9l-2-3.4-2 .6A7.5 7.5 0 0 0 14 5l-.5-2z"/><circle cx="11.25" cy="11.5" r="3"/></svg></button>}
          <div className="profile-switch nav-profile-switch" style={{ "--profile": active.color } as React.CSSProperties}><button className="profile-switch-trigger" title={`${active.name} · ${active.role}`} aria-label={`Active profile: ${active.name}`} aria-expanded={profileMenuOpen} onClick={(event) => { profileMenuReturnFocusRef.current = event.currentTarget; setProfileMenuOpen((open) => !open); }}><ProfileMark profile={active} small /><strong>{active.name}</strong><span>›</span></button>{profileMenuOpen && <div className="profile-menu" role="group" aria-label="Profile menu"><div className="profile-options" aria-label="Choose active profile">{state.profiles.map((p) => <button key={p.id} aria-pressed={p.id === active.id} className={p.id === active.id ? "active" : ""} style={{ "--profile": p.color } as React.CSSProperties} onClick={() => { savePreference("lt-active-profile", p.id); setActiveId(p.id); setProfileMenuOpen(false); }}><ProfileMark profile={p} small /><span><strong>{p.name}</strong><small>{p.role}</small></span></button>)}</div><button className="profile-settings-link" onClick={() => { setProfileMenuOpen(false); setProfileSettingsOpen(true); }}><span>⚙</span><strong>Settings…</strong></button></div>}</div>
          {view === "script" && <div className="nav-script-tools" role="group" aria-label="Script zoom"><span>Script zoom</span><div><button aria-label="Zoom out" onClick={() => setPdfScale(Math.max(.9, +(pdfScale - .15).toFixed(2)))}>−</button><b>{Math.round(pdfScale / 1.35 * 100)}%</b><button aria-label="Zoom in" onClick={() => setPdfScale(Math.min(2.1, +(pdfScale + .15).toFixed(2)))}>＋</button></div>{anchorRequest && <small>{anchorRequest.mode === "note" ? "PLACING NOTE" : anchorRequest.mode === "edit" ? "MOVING CUE" : "PLACING CUE"}</small>}</div>}
          <button className="nav-brand" aria-label="Open script" title={desktopMode ? defaultState.document.filename : "Lighting Design"} onClick={() => setView("script")}><Image className="brand-mark" src="/brand-mark.png" alt="" width={32} height={32} /></button>
        </div>
      </aside>

      <section className={`workspace ${view === "cues" && cueListPanelOpen && selectedCue ? "cue-list-detail-open" : ""}`}>
        <Activity mode={view === "script" ? "visible" : "hidden"}><ScriptView compactDetails={cuePanelCompact} editorClosing={cuePanelClosing} readingPreferences={scriptReading} state={state} selectedCue={selectedCue} selectCue={(id,preservePosition)=>selectCue(id,false,"script",preservePosition)} chooseAnchor={chooseAnchor} chooseNoteTarget={chooseNoteTarget} placeNote={placeNote} onOpenDiscussion={(id) => { const discussion = state.discussions.find((item) => item.id === id); if (discussion) showDiscussion(discussion, false); }} onDismissDiscussion={() => setFocusedDiscussionId(null)} onOpenCueNotes={openCueNotes} anchorRequest={anchorRequest} setCreateNumbering={(assignNumber) => setAnchorRequest((request) => request?.mode === "create" ? { ...request, assignNumber } : request)} cancelAnchor={() => { setAnchorRequest(null); setPendingNote(null); setCommentText(""); if (syncMode === "v2") void syncV2ClientRef.current?.clearDraft("note-draft"); }} setPage={setScriptPage} setScriptSceneId={setScriptSceneId} scale={pdfScale} zoomIn={() => setPdfScale((current) => Math.min(2.1, +(current + .15).toFixed(2)))} zoomOut={() => setPdfScale((current) => Math.max(.9, +(current - .15).toFixed(2)))} zoomLabel={`${Math.round(pdfScale / 1.35 * 100)}%`} noteVisibility={noteVisibility} outOfOrderCueIds={outOfOrderCueIds} scriptJump={scriptJump} openSceneInList={openSceneInList} pendingNote={pendingNote} commentText={commentText} setCommentText={setCommentDraft} postPlacedNote={postPlacedNote} replyToNote={replyInlineNote} focusedDiscussionId={focusedDiscussionId} replyingToId={replyingToId} replyText={replyText} setReplyText={setReplyDraft} startReply={(id) => { if (!requireEditGate()) return; setReplyingToId(id); setReplyText(""); }} cancelReply={cancelReplyDraft} postReply={postReply} toggleResolved={toggleResolved} moveCue={beginEditAnchor} deleteCue={requestDeleteCue} toggleCueMode={(cueId) => { const cue = state.cues.find((item) => item.id === cueId); if (cue) updateCueById(cueId, { mode: cue.mode === "implemented" ? "planned" : "implemented" }, { type: "cue_status", text: `marked this cue ${cue.mode === "implemented" ? "Planned" : "Implemented"}.` }); }} toggleCueBlackout={(cueId) => { const cue = state.cues.find((item) => item.id === cueId); if (cue) updateCueById(cueId, { blackout: !cue.blackout }, { type: "cue_blackout", text: `${cue.blackout ? "removed blackout from" : "marked"} this cue${cue.blackout ? "" : " as a blackout"}.` }); }} editCueNumber={setNumberTargetId} unassignCueNumber={unassignCueNumber} busyGroups={syncControlGroups} /></Activity>
        {view === "cues" && <CuesView busyGroups={syncControlGroups} state={state} filter={modeFilter} setFilter={setModeFilter} openCount={openCount} scene={scene} selectedCueId={cueListPanelOpen ? selectedCueId : null} selectCue={(id)=>selectCue(id,true,"cues")} assignCueNumber={assignCueNumber} editCueNumber={setNumberTargetId} moveCue={beginEditAnchor} showCueInScript={id=>{const cue=state.cues.find(cue=>cue.id===id);if(cue){selectCue(id,false);setScriptJump({page:cue.page,anchorY:cue.anchorY,key:uid("jump")});}}} deleteCue={requestDeleteCue} assignAllCueNumbers={() => assignAllCueNumbers()} openTrash={() => setTrashOpen(true)} createCue={beginAddCue} outOfOrderCueIds={outOfOrderCueIds} />}
        {view === "inbox" && <InboxView recoveryItems={syncRecoveryItems} getRecoveryClient={getSyncV2Client} recoveryCueNames={Object.fromEntries([...state.cues, ...state.deletedCues.map((item) => item.cue)].map((cue) => [cue.id, cue.title || formatCueNumber(cue.number, cue.id)]))} downloadRecovery={downloadSyncRecovery} discardRecovery={discardSyncRecovery} discardAllRecovery={discardAllSyncRecovery} cancelRecoveryDiscard={() => setDiscardRecoveryId(null)} discardRecoveryId={discardRecoveryId} syncProblem={inboxProblem} busyGroups={syncControlGroups} state={state} active={active} scope={inboxScope} setScope={setInboxScope} sceneFilter={inboxScene} setSceneFilter={setInboxScene} typeFilter={inboxType} setTypeFilter={setInboxType} profile={profile} openActivity={openActivity} dismiss={dismissActivities} toggleResolved={toggleResolved} togglePin={toggleActivityPins} />}
        {view === "scenes" && <ScenesView busyGroups={syncControlGroups} state={state} profile={profile} claimSceneGroup={claimSceneGroup} unassignSceneGroup={unassignSceneGroup} activeId={active.id} focusedSceneId={focusedSceneId} openSceneInScript={openSceneInScript} assignGroupCueNumbers={assignAllCueNumbers} />}
        {view === "search" && <SearchView query={search} setQuery={updateSearch} typeFilter={searchTypeFilter} setTypeFilter={(value) => { setSearchTypeFilter(value); setSearchPage(1); }} personFilter={searchPersonFilter} setPersonFilter={(value) => { setSearchPersonFilter(value); setSearchPage(1); }} sceneFilter={searchSceneFilter} setSceneFilter={(value) => { setSearchSceneFilter(value); setSearchPage(1); }} profiles={state.profiles} scenes={state.scenes} totalResults={filteredSearchResults.length} page={pagedSearchResults.page} pageCount={pagedSearchResults.pageCount} results={pagedSearchResults.results} setPage={setSearchPage} openResult={(result) => openSearchResult(result, false)} close={() => setView("script")} />}
      </section>

      {(view === "script" || view === "cues" && cueListPanelOpen) && selectedCue && !anchorRequest && <CuePanel navigationCues={cueNavigation} origin={view === "cues" ? "cues" : "script"} onShowInScript={view === "cues" ? ()=>{selectCue(selectedCue.id,false);setScriptJump({page:selectedCue.page,anchorY:selectedCue.anchorY,key:uid("jump")});}:undefined} compact={view === "cues" ? false : cuePanelCompact} closing={cuePanelClosing} initialExpanded={cuePanelExpanded} documentRevision={textRevisions[selectedCue.id] ?? null} key={`${view}:${selectedCue.id}`} cue={selectedCue} state={state} profile={profile} scene={scene} updateCue={updateCue} onCollaborativeTextKeyDown={handleCollaborativeTextKeyDown} onCompositionStart={beginTextComposition} onCompositionEnd={endTextComposition} onPasteBoundary={markTextPasteBoundary} noteVisibility={noteVisibility} notesFocusRequest={cueNotesRequest} focusedDiscussionId={focusedDiscussionId} onDismissDiscussion={() => setFocusedDiscussionId(null)} replyingToId={replyingToId} replyText={replyText} setReplyText={setReplyDraft} startReply={(id) => { if (!requireEditGate()) return; setReplyingToId(id); setReplyText(""); }} cancelReply={cancelReplyDraft} postReply={postReply} toggleResolved={toggleResolved} assignNumber={() => assignCueNumber(selectedCue.id)} unassignNumber={() => unassignCueNumber(selectedCue.id)} editAnchor={() => beginEditAnchor(selectedCue.id)} deleteCue={() => requestDeleteCue(selectedCue.id)} close={closeCuePanel} previous={(expanded = true) => navigateCueCard(-1,expanded)} next={(expanded = true) => navigateCueCard(1,expanded)} outOfOrder={outOfOrderCueIds.has(selectedCue.id)} autoFocusTitle={newCueFocusId === selectedCue.id} onTitleFocused={() => setNewCueFocusId((current) => current === selectedCue.id ? null : current)} onNumberError={setValidationError} readOnly={selectedCueWriteBlocked} busyGroups={selectedCueBusyGroups} saving={selectedCueSaving} targetRecoveryBlocked={selectedCueRecoveryBlocked} reviewRecovery={handleSyncProblem} restoreTextHistory={restoreTextHistory} preserveRejectedPaste={preserveRejectedPaste} remoteTextChanges={remoteTextChanges} clearRemoteTextChange={clearRemoteTextChange} />}
      <nav className="mobile-nav">{nav.filter(item => !desktopMode || item.id !== "inbox").map((item) => <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={`${view === item.id ? "active " : ""}${item.id === "inbox" && syncHasProblem ? "recovery-alert" : ""}`.trim()} onClick={() => setView(item.id)}><span>{item.glyph}</span>{item.label}{item.id === "inbox" && inboxCount > 0 && <b>{inboxCount}</b>}</button>)}<div className="profile-switch mobile-profile-switch" style={{ "--profile": active.color } as React.CSSProperties}><button className="profile-switch-trigger" aria-label={`Active profile: ${active.name}`} aria-expanded={profileMenuOpen} onClick={(event) => { profileMenuReturnFocusRef.current = event.currentTarget; setProfileMenuOpen((open) => !open); }}><ProfileMark profile={active} small /></button>{profileMenuOpen && <div className="profile-menu" role="group" aria-label="Profile menu"><div className="profile-options" aria-label="Choose active profile">{state.profiles.map((p) => <button key={p.id} aria-pressed={p.id === active.id} className={p.id === active.id ? "active" : ""} style={{ "--profile": p.color } as React.CSSProperties} onClick={() => { savePreference("lt-active-profile", p.id); setActiveId(p.id); setProfileMenuOpen(false); }}><ProfileMark profile={p} small /><span><strong>{p.name}</strong><small>{p.role}</small></span></button>)}</div><button className="profile-settings-link" onClick={() => { setProfileMenuOpen(false); setProfileSettingsOpen(true); }}><span>⚙</span><strong>Settings…</strong></button></div>}</div></nav>
      {profileSettingsOpen && <ProfileSettingsDialog readingPreferences={scriptReading} setReadingPreferences={updateScriptReading} busyGroups={syncControlGroups} profiles={state.profiles} draft={profileDraft} setDraft={updateProfileDraft} beginEdit={beginProfileEdit} save={commitProfile} theme={theme} setTheme={(value) => { savePreference("lt-theme", value); setTheme(value); }} backupAvailable={syncMode === "v2" && connectionState === "online"} close={() => setProfileSettingsOpen(false)} />}
      {numberTargetCue && <CueNumberDialog key={numberTargetCue.id} cue={numberTargetCue} cues={state.cues} readOnly={syncWriteBlocked || !active || syncControlGroups.has(`cue:${numberTargetCue.id}:text`)} busy={syncControlGroups.has(`cue:${numberTargetCue.id}:assignment`)} close={() => setNumberTargetId(null)} change={(number) => {
        if (!requireEditGate() || syncMode === "v2" && !syncV2ClientRef.current?.canEditTarget(numberTargetCue.id)) return false;
        updateCueById(numberTargetCue.id, { number, mode:numberTargetCue.mode === "unassigned" ? "planned" : numberTargetCue.mode }, { type:"cue_number", text:`changed the cue number to ${formatCueNumber(number)}.` });
        return true;
      }} assign={() => assignCueNumber(numberTargetCue.id)} unassign={() => unassignCueNumber(numberTargetCue.id)} />}
      {deleteTargetId && <DeleteCueDialog cue={state.cues.find((cue) => cue.id === deleteTargetId)} notes={state.discussions.filter((discussion) => discussion.cueId === deleteTargetId)} scene={scene} busy={deleteBusy} cancel={() => { if (!deleteBusy) setDeleteTargetId(null); }} confirm={() => void confirmDeleteCue()} />}
      {trashOpen && <RecentlyDeletedDialog focusCueId={trashFocusId} deleted={state.deletedCues} profile={profile} restore={(cueId) => restoreDeletedCue(cueId)} busyGroups={syncControlGroups} close={() => { setTrashOpen(false); setTrashFocusId(null); }} />}
      {sceneTransferIds && <ModalShell className="confirm-dialog" role="alertdialog" labelledBy="scene-transfer-title" onClose={() => setSceneTransferIds(null)}><header><span>CONFIRM TRANSFER</span><h2 id="scene-transfer-title">Take ownership of this scene group?</h2></header><p>This group is already assigned. Continuing will transfer every scene in the group to {active.name}.</p><ul className="scene-transfer-members">{sceneTransferIds.map(id=>{const member=scene(id);return member?<li key={id}><strong>Scene {member.number} · {member.name}</strong><span>{profile(member.ownerId)?.name??"Unassigned"}</span></li>:null;})}</ul><footer><button data-autofocus onClick={() => setSceneTransferIds(null)}>Cancel</button><button className="primary-button" onClick={() => { const ids = sceneTransferIds; setSceneTransferIds(null); claimSceneGroup(ids, true); }}>Transfer ownership</button></footer></ModalShell>}
      {undoDeleteId && <div className="undo-toast" role="status"><span>Cue moved to Recently deleted.</span><button disabled={syncBusyGroups.has(`cue:${undoDeleteId}:lifecycle`)} onClick={() => restoreDeletedCue(undoDeleteId, true)}>Undo</button><button aria-label="Dismiss" onClick={() => setUndoDeleteId(null)}>×</button></div>}
      {dismissUndo && <div className="undo-toast inbox-dismiss-toast" role="status"><span>{dismissUndo.count === 1 ? "Update moved to Past." : `${dismissUndo.count} updates moved to Past.`}</span><button disabled={dismissUndo.eventIds.some((eventId) => syncBusyGroups.has(`inbox:${dismissUndo.profileId}:${eventId}`))} onClick={undoDismissActivities}>Undo</button><button aria-label="Dismiss notification" onClick={() => setDismissUndo(null)}>×</button></div>}
    </main>
  );
}

function ScriptView({ compactDetails, editorClosing, readingPreferences, state, selectedCue, selectCue, chooseAnchor, chooseNoteTarget, placeNote, onOpenDiscussion, onDismissDiscussion, onOpenCueNotes, anchorRequest, setCreateNumbering, cancelAnchor, setPage, setScriptSceneId, scale, zoomIn, zoomOut, zoomLabel, noteVisibility, outOfOrderCueIds, scriptJump, openSceneInList, pendingNote, commentText, setCommentText, postPlacedNote, replyToNote, focusedDiscussionId, replyingToId, replyText, setReplyText, startReply, cancelReply, postReply, toggleResolved, moveCue, deleteCue, toggleCueMode, toggleCueBlackout, editCueNumber, unassignCueNumber, busyGroups }: { compactDetails: boolean; editorClosing: boolean; readingPreferences: ScriptReadingPreferences; state: WorkspaceState; selectedCue: Cue | null; selectCue: (id: string, preservePosition?: boolean) => void; chooseAnchor: (draft: PdfAnchorDraft, type: "line" | "phrase") => void; chooseNoteTarget: (target: { type: "cue" | "scene"; id: string }, draft?: PdfAnchorDraft) => void; placeNote: (target: { type: "cue" | "scene"; id: string } | null, draft: PdfAnchorDraft) => void; onOpenDiscussion: (id: string) => void; onDismissDiscussion: () => void; onOpenCueNotes: (cueId: string) => void; anchorRequest: AnchorRequest | null; setCreateNumbering: (assignNumber: boolean) => void; cancelAnchor: () => void; setPage: (page: number) => void; setScriptSceneId: (sceneId: string) => void; scale: number; zoomIn: () => void; zoomOut: () => void; zoomLabel: string; noteVisibility: NoteVisibility; outOfOrderCueIds: ReadonlySet<string>; scriptJump: ScriptJumpRequest | null; openSceneInList: (sceneId: string) => void; pendingNote: PendingNote | null; commentText: string; setCommentText: (value: string) => void; postPlacedNote: () => void; replyToNote: (discussionId: string) => void; focusedDiscussionId: string | null; replyingToId: string | null; replyText: string; setReplyText: (value: string) => void; startReply: (id: string) => void; cancelReply: () => void; postReply: (id: string) => void; toggleResolved: (discussion: Discussion) => void; moveCue: (id: string) => void; deleteCue: (id: string) => void; toggleCueMode: (id: string) => void; toggleCueBlackout: (id: string) => void; editCueNumber: (id: string) => void; unassignCueNumber: (id: string) => void; busyGroups: ReadonlySet<string> }) {
  const frameRef = useRef<HTMLDivElement>(null);
  // The inline composer now owns noteInputRef.current?.focus() inside PdfScriptViewer.
  const discussionCounts = useMemo(() => cueNoteCounts(state.discussions, noteVisibility), [noteVisibility, state.discussions]);
  return <ScriptWorkspace frameRef={frameRef} detailOpen={!!selectedCue && !anchorRequest && !editorClosing && !compactDetails}>
    <section className="script-canvas"><ScriptReadingProgress frameRef={frameRef} /><div ref={frameRef} className="pdf-frame">
      {anchorRequest && <div className="anchor-request-banner" role="status"><span className="anchor-request-dot" /><div><b>{anchorRequest.mode === "create" ? "PLACE NEW CUE" : anchorRequest.mode === "note" ? "PLACE NOTE" : `MOVE ${selectedCue ? cueLabel(selectedCue) : "CUE"}${selectedCue ? ` · ${selectedCue.title}` : ""}`}</b><small>{anchorRequest.mode === "note" ? "Click a cue, scene marker, or script position." : "Click one word or highlight a phrase, then choose a word or line cue."}</small></div>{anchorRequest.mode === "create" && <button className={anchorRequest.assignNumber ? "number-on-create active" : "number-on-create"} aria-pressed={anchorRequest.assignNumber} onClick={() => setCreateNumbering(!anchorRequest.assignNumber)}>{anchorRequest.assignNumber ? "AUTO-NUMBER ON" : "START UNASSIGNED"}</button>}<button onClick={cancelAnchor}>Cancel</button></div>}
      <PdfScriptViewer readingPreferences={readingPreferences} pageCount={state.document.pages} scale={scale} cues={state.cues} scenes={state.scenes} profiles={state.profiles} discussions={state.discussions} discussionCounts={discussionCounts} noteVisibility={noteVisibility} selectedCueId={selectedCue?.id ?? null} anchorMode={!!anchorRequest && anchorRequest.mode !== "note"} noteMode={anchorRequest?.mode === "note"} pendingNote={pendingNote} commentText={commentText} setCommentText={setCommentText} onCancelPendingNote={cancelAnchor} onPostPendingNote={postPlacedNote} outOfOrderCueIds={outOfOrderCueIds} jumpRequest={scriptJump} onVisiblePage={setPage} onVisibleScene={setScriptSceneId} onSelectCue={id=>selectCue(id,true)} onOpenCueNotes={onOpenCueNotes} onOpenScene={openSceneInList} onAnchorChosen={chooseAnchor} onNoteTarget={chooseNoteTarget} onPlaceNote={placeNote} onReplyNote={replyToNote} onOpenDiscussion={onOpenDiscussion} onDismissDiscussion={onDismissDiscussion} focusedDiscussionId={focusedDiscussionId} replyingToId={replyingToId} replyText={replyText} setReplyText={setReplyText} startReply={startReply} cancelReply={cancelReply} postReply={postReply} toggleResolved={toggleResolved} onMoveCue={moveCue} onDeleteCue={deleteCue} onToggleCueMode={toggleCueMode} onToggleCueBlackout={toggleCueBlackout} onEditCueNumber={editCueNumber} onUnassignCueNumber={unassignCueNumber} busyGroups={busyGroups} onZoomIn={zoomIn} onZoomOut={zoomOut} zoomLabel={zoomLabel} />
    </div></section>
  </ScriptWorkspace>;
}

function CuePanel({ navigationCues, origin = "script", onShowInScript, compact, closing, initialExpanded, documentRevision, cue, state, profile, scene, updateCue, onCollaborativeTextKeyDown, onCompositionStart, onCompositionEnd, onPasteBoundary, noteVisibility, notesFocusRequest, focusedDiscussionId, onDismissDiscussion, replyingToId, replyText, setReplyText, startReply, cancelReply, postReply, toggleResolved, assignNumber, unassignNumber, editAnchor, deleteCue, close, previous, next, outOfOrder, autoFocusTitle, onTitleFocused, onNumberError, readOnly, busyGroups, saving, targetRecoveryBlocked, reviewRecovery, restoreTextHistory, preserveRejectedPaste, remoteTextChanges, clearRemoteTextChange }: { navigationCues: Cue[]; origin?: "script" | "cues"; onShowInScript?: () => void; compact: boolean; closing: boolean; initialExpanded: boolean; documentRevision: number | null; cue: Cue; state: WorkspaceState; profile: (id?: string | null) => Profile | undefined; scene: (id: string) => Scene | undefined; updateCue: (patch: Partial<Cue>, activity?: { type: ActivityType; text: string }) => void; onCollaborativeTextKeyDown: (cueId: string, event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void; onCompositionStart: (cueId: string) => void; onCompositionEnd: (cueId: string, field: "title" | "description" | "technicalNotes", value: string) => void; onPasteBoundary: (cueId: string) => void; noteVisibility: NoteVisibility; notesFocusRequest: number; focusedDiscussionId: string | null; onDismissDiscussion: () => void; replyingToId: string | null; replyText: string; setReplyText: (value: string) => void; startReply: (id: string) => void; cancelReply: () => void; postReply: (id: string) => void; toggleResolved: (discussion: Discussion) => void; assignNumber: () => void; unassignNumber: () => void; editAnchor: () => void; deleteCue: () => void; close: () => void; previous: (expanded?: boolean) => void; next: (expanded?: boolean) => void; outOfOrder: boolean; autoFocusTitle: boolean; onTitleFocused: () => void; onNumberError: (message: string | null) => void; readOnly: boolean; busyGroups: ReadonlySet<string>; saving: boolean; targetRecoveryBlocked: boolean; reviewRecovery: () => void; restoreTextHistory: (cueId: string, historyRevision: number, expectedDocumentRevision: number) => void; preserveRejectedPaste: (cueId: string, field: string, label: string, value: string) => void; remoteTextChanges: ReadonlySet<string>; clearRemoteTextChange: (cueId: string, field: string) => void }) {
  const [phoneExpanded, setPhoneExpanded] = useState(autoFocusTitle || initialExpanded);
  const pillRef = useRef<HTMLButtonElement>(null);
  const [phoneLayout, setPhoneLayout] = useState(() => typeof window !== "undefined" && (window.innerWidth < (origin === "cues" ? 1100 : 900) || compact));
  useEffect(() => {
    const query = window.matchMedia(origin === "cues" ? "(max-width:1099px)" : "(max-width:899px)");
    const update = () => setPhoneLayout(query.matches || compact);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [compact, origin]);
  const pillPresence = useCuePresence(phoneLayout && !phoneExpanded && !closing);
  const cardPresence = useCuePresence(!closing && (!phoneLayout || phoneExpanded));
  const editStart = useRef<Record<string, string>>({});
  const resizeCleanup = useRef<(() => void) | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const sheetDragDistance = useRef(0);
  const [sheetHeight, setSheetHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!phoneExpanded || !phoneLayout) return;
    const panel = panelRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const pill = pillRef.current;
    const siblings = [...(panel?.parentElement?.children ?? [])].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== panel);
    const releaseInert = holdInert(siblings);
    const focusable = () => [...(panel?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? [])].filter(element => element.getClientRects().length > 0 && !element.closest("[hidden],[inert]"));
    const timer = window.setTimeout(() => (autoFocusTitle ? titleRef.current : focusable()[0])?.focus(), 0);
    const keydown = (event: KeyboardEvent) => {
      if (panel?.closest("[inert]")) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); if (origin === "cues") close(); else setPhoneExpanded(false); }
      if (event.key === "Tab") {
        const items = focusable(), first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { window.clearTimeout(timer); document.removeEventListener("keydown", keydown, true); releaseInert(); (pill ?? previous)?.focus(); };
  }, [phoneExpanded, phoneLayout, autoFocusTitle, origin, close]);
  const finishPanel = () => { if (phoneLayout && origin === "script") setPhoneExpanded(false); else close(); };
  const suffix = cueNumberSuffix(cue.number);
  const [numberDraft, setNumberDraft] = useState(suffix);
  const [editingNumber, setEditingNumber] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyVersions, setHistoryVersions] = useState<TextHistoryVersion[]>([]);
  const [historyRevision, setHistoryRevision] = useState<number | null>(null);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TextHistoryVersion | null>(null);
  const numberAtFocus = useRef(suffix);
  const numberInputInvalid = useRef(false);
  const assignmentBusy = busyGroups.has(`cue:${cue.id}:assignment`);
  const blackoutBusy = busyGroups.has(`cue:${cue.id}:blackout`);
  const positionBusy = busyGroups.has(`cue:${cue.id}:position`);
  const lifecycleBusy = busyGroups.has(`cue:${cue.id}:lifecycle`);
  const cueDiscussions = useMemo(() => state.discussions.filter((discussion) => discussionTargetType(discussion) === "cue" && discussion.cueId === cue.id && noteVisibility !== "none" && (noteVisibility === "all" || !discussion.resolved)), [cue.id, noteVisibility, state.discussions]);
  useEffect(() => {
    if (!autoFocusTitle) return;
    titleRef.current?.focus();
    titleRef.current?.select();
    onTitleFocused();
  }, [autoFocusTitle, onTitleFocused]);
  const handleTextKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    onCollaborativeTextKeyDown(cue.id, event);
  };
  const pasteGuard = (field: "title" | "description" | "technicalNotes", label: string, current: string, limit: number) => (event: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    onPasteBoundary(cue.id);
    window.requestAnimationFrame(() => onPasteBoundary(cue.id));
    const pasted = event.clipboardData.getData("text");
    const start = event.currentTarget.selectionStart ?? current.length;
    const end = event.currentTarget.selectionEnd ?? start;
    const nextLength = current.length - (end - start) + pasted.length;
    if (nextLength <= limit || nextLength < current.length) return;
    event.preventDefault();
    preserveRejectedPaste(cue.id, field, label, pasted);
  };
  const setNumberSuffix = (value: string) => {
    numberInputInvalid.current = !/^\s*\d*(?:\.\d*)?\s*$/.test(value);
    setNumberDraft(sanitizeCueSuffix(value));
  };
  const commitNumberSuffix = () => {
    setEditingNumber(false);
    if (numberDraft === numberAtFocus.current && !numberInputInvalid.current) return;
    if (numberInputInvalid.current || !isValidCueSuffix(numberDraft)) {
      setNumberDraft(suffix);
      onNumberError(numberDraft.trim().length + CUE_NUMBER_PREFIX.length > FIELD_LIMITS.cueNumber
        ? `Cue numbers must be ${FIELD_LIMITS.cueNumber} characters or fewer, including the LX prefix.`
        : "Cue numbers must be positive, with at most three decimal places.");
      numberInputInvalid.current = false;
      return;
    }
    const normalized = parseCueNumber(numberDraft)!;
    if (normalized !== cue.number) updateCue({ number: normalized }, { type: "cue_number", text: `changed the cue number to ${CUE_NUMBER_PREFIX}${normalized}.` });
  };
  const beginEdit = (field: "title" | "description" | "technicalNotes", value: string) => { editStart.current[field] = value; };
  const finishEdit = (field: "title" | "description" | "technicalNotes", value: string, text: string, type: ActivityType = "cue_edited") => {
    if (editStart.current[field] !== undefined && editStart.current[field] !== value) updateCue({}, { type, text });
    delete editStart.current[field];
    clearRemoteTextChange(cue.id, field);
  };
  useEffect(() => () => resizeCleanup.current?.(), []);
  useEffect(() => {
    if (!notesFocusRequest || phoneLayout && !phoneExpanded) return;
    const frame = window.requestAnimationFrame(() => { document.getElementById(`cue-notes-${cue.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); });
    return () => window.cancelAnimationFrame(frame);
  }, [cue.id, notesFocusRequest, phoneLayout, phoneExpanded]);
  const usesSheetLayout = () => window.innerWidth <= 1279 || window.innerWidth / window.innerHeight < 1.34;
  const beginSheetResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!usesSheetLayout()) return;
    event.preventDefault();
    const panel = event.currentTarget.closest<HTMLElement>(".cue-panel");
    if (!panel) return;
    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    sheetDragDistance.current = 0;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeCleanup.current?.();
    const cleanup = startSheetResize(window, {
      startY,
      startHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.visualViewport?.height ?? window.innerHeight,
      onHeight: setSheetHeight,
      onTravel: (distance) => { sheetDragDistance.current = distance; },
    });
    resizeCleanup.current = () => {
      cleanup();
      resizeCleanup.current = null;
    };
  };
  const toggleSheet = () => {
    if (!usesSheetLayout() || sheetDragDistance.current > 5) return;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const topAllowance = window.innerWidth <= 1024 ? 110 : 70;
    const expandedHeight = Math.max(240, viewportHeight - topAllowance);
    const collapsedHeight = Math.min(window.innerWidth <= 1024 ? 360 : 330, viewportHeight * (window.innerWidth <= 1024 ? .42 : .34));
    setSheetHeight((height) => (height ?? collapsedHeight) > (collapsedHeight + expandedHeight) / 2 ? collapsedHeight : expandedHeight);
  };
  useEffect(() => {
    const clampSheetHeight = () => {
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const topAllowance = window.innerWidth <= 1024 ? 110 : 70;
      const maxHeight = Math.max(240, viewportHeight - topAllowance);
      setSheetHeight((height) => height === null ? null : Math.min(height, maxHeight));
    };
    window.addEventListener("resize", clampSheetHeight);
    window.visualViewport?.addEventListener("resize", clampSheetHeight);
    return () => {
      window.removeEventListener("resize", clampSheetHeight);
      window.visualViewport?.removeEventListener("resize", clampSheetHeight);
    };
  }, []);
  const historyRequest = useRef(0);
  const loadHistory = useCallback(async (before?: number) => {
    const request = ++historyRequest.current;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await fetch(`/api/sync/history/${encodeURIComponent(cue.id)}${before !== undefined ? `?before=${before}` : ""}`, { cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("Saved versions could not be loaded.");
      const body = await response.json() as { currentDocumentRevision: number; nextCursor: number | null; versions: TextHistoryVersion[] };
      if (request !== historyRequest.current || documentRevision !== null && body.currentDocumentRevision < documentRevision) return;
      setHistoryRevision(body.currentDocumentRevision);
      setHistoryCursor(body.nextCursor);
      setHistoryVersions((current) => before !== undefined ? [...new Map([...current, ...body.versions].map((version) => [version.revision, version])).values()] : body.versions);
    } catch (error) { if (request === historyRequest.current) setHistoryError(error instanceof Error ? error.message : "Saved versions could not be loaded."); }
    finally { if (request === historyRequest.current) setHistoryLoading(false); }
  }, [cue.id, documentRevision]);
  useEffect(() => {
    const timer = historyOpen ? window.setTimeout(() => void loadHistory(), 0) : null;
    return () => { if (timer !== null) window.clearTimeout(timer); historyRequest.current += 1; };
  }, [historyOpen, loadHistory]);
  const toggleHistory = () => setHistoryOpen((open) => !open);

  const previewNote = [...cueDiscussions].sort((a,b) => Number(a.resolved) - Number(b.resolved) || b.createdAt.localeCompare(a.createdAt))[0];
  return <><div className={`phone-cue-pill ${phoneLayout ? "compact-cue-pill" : ""} ${cue.mode} ${cue.blackout ? "blackout" : ""}`} data-motion={pillPresence.phase} hidden={!pillPresence.present}><button type="button" className="phone-cue-previous" aria-label="Previous cue" onClick={() => previous(false)}><ArrowIcon direction="left" /></button><button className="phone-cue-open" ref={pillRef} type="button" aria-haspopup="dialog" aria-label={`Open ${cueLabel(cue)}: ${cue.title}`} onClick={() => setPhoneExpanded(true)}><span className="cue-pill-copy"><span className="cue-pill-title"><strong>{cueLabel(cue)}</strong><span className="cue-pill-title-text">{cue.title}</span></span>{previewNote && <span className="cue-pill-note">{previewNote.content}</span>}</span><i aria-hidden="true">⌃</i></button><button type="button" className="phone-cue-next" aria-label="Next cue" onClick={() => next(false)}><ArrowIcon direction="right" /></button><button type="button" aria-label="Dismiss selected cue" onClick={close}><CloseIcon /></button></div><aside ref={panelRef} data-origin={origin} data-motion={cardPresence.phase} hidden={!cardPresence.present} inert={cardPresence.phase === "exiting"} aria-label="Cue details" role={phoneExpanded && phoneLayout ? "dialog" : undefined} aria-modal={phoneExpanded && phoneLayout || undefined} className={`cue-panel approved-cue-editor ${phoneLayout ? "compact-cue-editor" : ""} ${phoneExpanded || phoneLayout && cardPresence.present ? "phone-expanded" : ""} ${cue.mode} ${cue.blackout ? "blackout" : ""} ${outOfOrder ? "out-of-order" : ""}`} style={{ "--cue-sheet-height": sheetHeight ? `${sheetHeight}px` : undefined } as React.CSSProperties}>
    <button type="button" className="cue-sheet-handle" aria-label="Drag or tap to resize cue details" onPointerDown={beginSheetResize} onClick={toggleSheet}><span /></button>
    <div className="panel-top"><div><button aria-label="Previous cue" onClick={() => previous(true)}>←</button><button aria-label="Next cue" onClick={() => next(true)}>→</button></div><span>{Math.max(0, navigationCues.findIndex((c) => c.id === cue.id) + 1)} / {navigationCues.length}</span><button className="done-editing" onClick={finishPanel} title="Done editing" aria-label="Done editing">Done</button></div>
    <div className="panel-scroll">
    {saving && <p className="target-recovery-warning" role="status">Saving this cue…</p>}
    {targetRecoveryBlocked && <p className="target-recovery-warning" role="alert">This cue change was not saved. <button type="button" onClick={reviewRecovery}>Review</button></p>}
    <div className="cue-identity">
      {cue.mode === "unassigned" || !cue.number ? <section className="cue-assignment-card"><span>UNASSIGNED CUE</span><strong>No LX number yet</strong><small>This cue must be assigned a number before it can be implemented.</small><button disabled={readOnly || assignmentBusy} onClick={assignNumber}>Assign next number</button></section> : <label className="editable-identity-field"><span>CUE NUMBER <button className="unassign-number" disabled={readOnly || assignmentBusy} onClick={unassignNumber} type="button">Unassign</button></span><span className="cue-number-control"><b>LX</b><input data-cue-text-field inputMode="decimal" aria-label="Editable cue number" readOnly={readOnly || assignmentBusy} placeholder="3.5" value={editingNumber ? numberDraft : suffix} onFocus={() => { numberAtFocus.current = suffix; numberInputInvalid.current = false; setNumberDraft(suffix); setEditingNumber(true); }} onChange={(e) => setNumberSuffix(e.target.value)} onBlur={commitNumberSuffix} onKeyDown={handleTextKeyDown} /></span><small></small>{outOfOrder && <strong className="order-warning">⚠ This cue number is out of script order.</strong>}</label>}
      <label className="editable-identity-field title-field"><span>CUE TITLE</span><input ref={titleRef} data-cue-text-field data-sync-cue-id={cue.id} data-sync-text-field="title" className="cue-title" aria-label="Editable cue title" readOnly={readOnly} maxLength={FIELD_LIMITS.cueTitle} placeholder="Name this lighting cue" value={cue.title} onFocus={() => beginEdit("title", cue.title)} onChange={(e) => updateCue({ title: e.target.value })} onPaste={pasteGuard("title", "cue title", cue.title, FIELD_LIMITS.cueTitle)} onCompositionStart={() => onCompositionStart(cue.id)} onCompositionEnd={(event) => onCompositionEnd(cue.id, "title", event.currentTarget.value)} onBlur={() => finishEdit("title", cue.title, "updated the cue title.")} onKeyDown={handleTextKeyDown} />{remoteTextChanges.has(`${cue.id}:title`) && <small className="remote-field-warning">{syncNotice("N20")}</small>}{cue.title.length > FIELD_LIMITS.cueTitle && <small className="field-limit-warning">{syncNotice("N21", { count: cue.title.length - FIELD_LIMITS.cueTitle })}</small>}</label>
      <p>{scene(cue.sceneId)?.name} · Page {scriptPageNumber(cue.page)} · {cue.anchorType === "phrase" ? "Word anchor" : "Line anchor"}: “{cue.selectedText}”</p>
      {cue.mode === "unassigned" ? <button className="mode-toggle unassigned" aria-label="Cue status: Unassigned. Assign a number to change status." disabled><span>UNASSIGNED</span><i><b /></i><span>NUMBER REQUIRED</span></button> : <div className="cue-status-choices" role="group" aria-label="Cue status">{(["planned", "implemented"] as const).map(mode => <button key={mode} type="button" disabled={readOnly || assignmentBusy} aria-pressed={cue.mode === mode} aria-label={mode === "planned" ? "Mark Planned" : "Mark Implemented"} className={mode} onClick={() => { if (cue.mode !== mode) updateCue({ mode }, { type: "cue_status", text: `marked this cue ${mode === "planned" ? "Planned" : "Implemented"}.` }); }}>{mode === "planned" ? "● Planned" : "✓ Implemented"}</button>)}</div>}
      <button className={`blackout-toggle ${cue.blackout ? "active" : ""}`} disabled={readOnly || blackoutBusy} aria-pressed={cue.blackout} onClick={() => updateCue({ blackout: !cue.blackout }, { type: "cue_blackout", text: `${cue.blackout ? "removed" : "marked"} BLACKOUT.` })}><span><i /> BLACKOUT</span><small>Stage goes fully dark on this cue.</small><b>{cue.blackout ? "ON" : "OFF"}</b></button>
    </div>
      <section className="field-block"><span className="field-label">LIGHTING INTENTION</span><textarea data-cue-text-field data-sync-cue-id={cue.id} data-sync-text-field="description" readOnly={readOnly} maxLength={FIELD_LIMITS.cueDescription} value={cue.description === "Describe the lighting intention." ? "" : cue.description} placeholder="Describe the lighting intention…" aria-label="Lighting intention" onFocus={() => beginEdit("description", cue.description)} onChange={(e) => updateCue({ description: e.target.value })} onPaste={pasteGuard("description", "lighting intention", cue.description, FIELD_LIMITS.cueDescription)} onCompositionStart={() => onCompositionStart(cue.id)} onCompositionEnd={(event) => onCompositionEnd(cue.id, "description", event.currentTarget.value)} onBlur={() => finishEdit("description", cue.description, "updated the lighting intention.")} onKeyDown={handleTextKeyDown} />{remoteTextChanges.has(`${cue.id}:description`) && <small className="remote-field-warning">{syncNotice("N20")}</small>}{cue.description.length > FIELD_LIMITS.cueDescription && <small className="field-limit-warning">{syncNotice("N21", { count: cue.description.length - FIELD_LIMITS.cueDescription })}</small>}</section>
      <section className="field-block"><span className="field-label">TECHNICAL NOTES</span><textarea data-cue-text-field data-sync-cue-id={cue.id} data-sync-text-field="technicalNotes" readOnly={readOnly} maxLength={FIELD_LIMITS.technicalNotes} value={cue.technicalNotes} placeholder="Console reference, fade, palette, dependencies…" aria-label="Technical and programming notes" onFocus={() => beginEdit("technicalNotes", cue.technicalNotes)} onChange={(e) => updateCue({ technicalNotes: e.target.value })} onPaste={pasteGuard("technicalNotes", "technical notes", cue.technicalNotes, FIELD_LIMITS.technicalNotes)} onCompositionStart={() => onCompositionStart(cue.id)} onCompositionEnd={(event) => onCompositionEnd(cue.id, "technicalNotes", event.currentTarget.value)} onBlur={() => finishEdit("technicalNotes", cue.technicalNotes, "updated the technical notes.")} onKeyDown={handleTextKeyDown} />{remoteTextChanges.has(`${cue.id}:technicalNotes`) && <small className="remote-field-warning">{syncNotice("N20")}</small>}{cue.technicalNotes.length > FIELD_LIMITS.technicalNotes && <small className="field-limit-warning">{syncNotice("N21", { count: cue.technicalNotes.length - FIELD_LIMITS.technicalNotes })}</small>}</section>
      <section className="anchor-card"><header><span>ANCHOR</span><button type="button" className="show-in-script" onClick={() => { if(onShowInScript){onShowInScript();return;} document.querySelector<HTMLElement>(`.reader-cue-marker[data-cue-id="${cue.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }); finishPanel(); }}>In script</button></header><strong>“{cue.selectedText}”</strong><small>{cue.enclosingLine}</small><button disabled={readOnly || positionBusy || assignmentBusy} onClick={editAnchor}>Move anchor</button></section>
      <section id={`cue-notes-${cue.id}`} className="cue-discussion-section" tabIndex={-1} aria-labelledby={`cue-notes-heading-${cue.id}`}><header className="section-title" id={`cue-notes-heading-${cue.id}`}><b>NOTES &amp; REPLIES</b><span>{cueDiscussions.length}</span></header>{noteVisibility === "none" ? <p className="cue-discussion-empty">Notes are hidden. Choose Active or All in the top bar to view them.</p> : cueDiscussions.length === 0 ? <p className="cue-discussion-empty">No open note threads on this cue.</p> : <div className="cue-discussion-list">{cueDiscussions.map((discussion) => <DiscussionCard key={discussion.id} surface="panel" discussion={discussion} profiles={state.profiles} focused={focusedDiscussionId === discussion.id} busy={busyGroups.has(`discussion:${discussion.id}`)} onOpen={() => undefined} onDismiss={onDismissDiscussion} replyingToId={replyingToId} replyText={replyText} onStartReply={startReply} onCancelReply={cancelReply} onPostReply={postReply} onToggleResolved={toggleResolved} setReplyText={setReplyText} />)}</div>}</section>
      <section className="history"><div className="section-title"><b>HISTORY</b><button type="button" aria-expanded={historyOpen} onClick={toggleHistory}>{historyOpen ? "Hide saved versions" : "View saved versions"}</button></div>{historyOpen && <div className="text-history-versions">{historyError && <p role="alert">{historyError} <button type="button" onClick={() => void loadHistory()}>Retry</button></p>}{historyVersions.map((version) => <article key={version.revision}><button type="button" onClick={(event) => { event.currentTarget.focus(); setPreview(version); }}><b>Version {version.revision}</b><small>{profile(version.actorId)?.name ?? "Unknown editor"}{version.createdAt ? ` · ${timeAgo(version.createdAt)}` : ""}</small></button></article>)}{historyCursor !== null && <button type="button" disabled={historyLoading} onClick={() => void loadHistory(historyCursor)}>Load earlier versions</button>}{historyLoading && <p role="status">Loading saved versions…</p>}</div>}{state.history.filter((h) => h.cueId === cue.id).map((event) => <p key={event.id}><span /> <b>{profile(event.actorId)?.name}</b> {event.text}<small>{timeAgo(event.createdAt)}</small></p>)}</section>
      {preview && createPortal(<ModalShell className="text-history-preview" labelledBy="history-preview-title" onClose={() => setPreview(null)}><header><b id="history-preview-title">Preview cue text version {preview.revision}</b><button type="button" data-autofocus aria-label="Close history preview" onClick={() => setPreview(null)}>×</button></header><dl><dt>Title</dt><dd>{preview.title || "Empty"}</dd><dt>Lighting intention</dt><dd>{preview.description || "Empty"}</dd><dt>Technical notes</dt><dd>{preview.technicalNotes || "Empty"}</dd></dl><footer><button type="button" onClick={() => setPreview(null)}>Cancel</button><button type="button" className="primary-button" disabled={readOnly || historyRevision === null || preview.revision === historyRevision || documentRevision !== null && historyRevision !== documentRevision} onClick={() => { if (historyRevision !== null) restoreTextHistory(cue.id, preview.revision, historyRevision); setPreview(null); }}>Restore as a new version</button></footer></ModalShell>, document.body)}
      <section className="cue-danger-zone"><button className="delete-cue" disabled={readOnly || lifecycleBusy} onClick={deleteCue}>Delete this cue</button></section>
    </div>
  </aside></>;
}

function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: React.ReactNode }) { return <header className="page-header"><div>{eyebrow && <span>{eyebrow}</span>}<h1>{title}</h1></div>{children}</header>; }

function SearchView({ query, setQuery, typeFilter, setTypeFilter, personFilter, setPersonFilter, sceneFilter, setSceneFilter, profiles, scenes, totalResults, page, pageCount, results, setPage, openResult, close }: {
  query: string;
  setQuery: (value: string) => void;
  typeFilter: "all" | WorkspaceSearchKind;
  setTypeFilter: (value: "all" | WorkspaceSearchKind) => void;
  personFilter: string;
  setPersonFilter: (value: string) => void;
  sceneFilter: string;
  setSceneFilter: (value: string) => void;
  profiles: Profile[];
  scenes: Scene[];
  totalResults: number;
  page: number;
  pageCount: number;
  results: SearchResult[];
  setPage: (page: number) => void;
  openResult: (result: SearchResult) => void;
  close: () => void;
}) {
  const firstResult = totalResults ? (page - 1) * 20 + 1 : 0;
  const lastResult = Math.min(totalResults, page * 20);
  return <div className="full-page full-search-page">
    <PageHeader eyebrow="WORKSPACE SEARCH" title="Search"><button type="button" className="search-close" onClick={close}>Back to script</button></PageHeader>
    <label className="full-search-query"><span>SEARCH</span><input aria-label="Search all workspace content" placeholder="Try cue 3.1, page 5, scene 23, or any text…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && results[0]) { event.preventDefault(); openResult(results[0]); } }} /></label>
    <div className="full-search-filters" aria-label="Search filters">
      <label><span>TYPE</span><select aria-label="Filter search by type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as "all" | WorkspaceSearchKind)}><option value="all">All types</option><option value="cue">Cues</option><option value="discussion">Notes and replies</option><option value="scene">Scenes</option><option value="script">Script text</option></select></label>
      <label><span>PERSON</span><select aria-label="Filter search by person" value={personFilter} onChange={(event) => setPersonFilter(event.target.value)}><option value="all">All people</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label>
      <label><span>SCENE</span><select aria-label="Filter search by scene" value={sceneFilter} onChange={(event) => setSceneFilter(event.target.value)}><option value="all">All scenes</option>{scenes.map((scene) => <option value={scene.id} key={scene.id}>{scene.number} · {scene.name}</option>)}</select></label>
    </div>
    <div className="full-search-summary"><b>{totalResults} {totalResults === 1 ? "result" : "results"}</b>{totalResults > 0 && <span>Showing {firstResult}–{lastResult}</span>}</div>
    <div className="full-search-results">
      {!query.trim() ? <p>Enter a search above to find cues, notes, scenes, and script text.</p> : results.length ? results.map((result) => <SearchResultRow key={searchResultKey(result)} result={result} onOpen={() => openResult(result)} />) : <p>No results match these filters.</p>}
    </div>
    {query.trim() && totalResults > 0 && <nav className="search-pagination" aria-label="Search result pages"><button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {pageCount}</span><button type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button></nav>}
  </div>;
}

function CueNumberDialog({ cue, cues, readOnly, busy, close, change, assign, unassign }: { cue: Cue; cues: Cue[]; readOnly: boolean; busy: boolean; close: () => void; change: (number: number) => boolean; assign: () => void; unassign: () => void }) {
  const [draft, setDraft] = useState(() => cueNumberSuffix(cue.number));
  const [error, setError] = useState("");
  const blocked = readOnly || busy;
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    const number = parseCueNumber(draft);
    if (number === null) { setError("Enter a positive cue number with at most three decimal places."); return; }
    if (cues.some((other) => other.id !== cue.id && other.number === number)) { setError(`${formatCueNumber(number)} is already in use. Choose a different number.`); return; }
    if (change(number)) close();
  };
  return <ModalShell className="confirm-dialog cue-number-dialog" labelledBy="cue-number-dialog-title" onClose={close} closeOnBackdrop><header><span>CUE NUMBER</span><h2 id="cue-number-dialog-title">{cue.number ? "Change cue number" : "Assign cue number"}</h2></header><p>{cue.title}</p><form onSubmit={save} noValidate><label htmlFor="cue-number-draft">Number<span className="cue-number-control"><b>LX</b><input id="cue-number-draft" aria-label="Cue number" data-autofocus inputMode="decimal" maxLength={FIELD_LIMITS.cueNumber - CUE_NUMBER_PREFIX.length} value={draft} disabled={blocked} aria-invalid={!!error} aria-describedby={error ? "cue-number-error" : undefined} onFocus={(event) => event.currentTarget.select()} onChange={(event) => { setDraft(event.target.value); setError(""); }} /></span></label>{error && <p className="number-error" id="cue-number-error" role="alert">{error}</p>}<footer className="number-dialog-actions">{cue.number ? <button type="button" disabled={blocked} onClick={() => { if (blocked) return; unassign(); close(); }}>Unassign number</button> : <button type="button" disabled={blocked} onClick={() => { if (blocked) return; assign(); close(); }}>Assign next number</button>}<div><button type="button" onClick={close}>Cancel</button><button type="submit" className="primary-button" disabled={blocked}>{cue.number ? "Save number" : "Assign number"}</button></div></footer></form></ModalShell>;
}

function ModalShell({ className, role = "dialog", labelledBy, onClose, closeOnBackdrop = false, children }: { className: string; role?: "dialog" | "alertdialog"; labelledBy: string; onClose: () => void; closeOnBackdrop?: boolean; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const visibleProfileTrigger = [...document.querySelectorAll<HTMLElement>(".profile-switch-trigger")].find((element) => element.getClientRects().length > 0);
    const activeElement = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    returnFocusRef.current = activeElement ?? visibleProfileTrigger ?? null;
    const dialog = dialogRef.current;
    const backdrop = dialog?.closest<HTMLElement>(".modal-backdrop");
    const backgroundSiblings = [...(backdrop?.parentElement?.children ?? [])].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop);
    const releaseInert = holdInert(backgroundSiblings);
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])') ?? [])];
    const focusTimer = window.setTimeout(() => (dialog?.querySelector<HTMLElement>("[data-autofocus]") ?? focusable()[0] ?? dialog)?.focus(), 0);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); dialog?.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", keydown);
      releaseInert();
      const target = returnFocusRef.current;
      const cueMenu = target?.closest(".cue-rail-actions")?.querySelector<HTMLButtonElement>(".cue-menu-trigger");
      if (cueMenu) {
        // Reveal hover-only actions before returning focus to their button.
        cueMenu.focus({ preventScroll:true });
        window.requestAnimationFrame(() => { if (target?.isConnected && !document.querySelector(".modal-backdrop")) target.focus({ preventScroll:true }); });
      } else returnFocusRef.current?.focus();
    };
  }, []);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (closeOnBackdrop && event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} className={className} role={role} aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>{children}</section></div>;
}

function CuesView({ selectedCueId, state, filter, setFilter, openCount, scene, selectCue, assignCueNumber, editCueNumber, moveCue, showCueInScript, assignAllCueNumbers, deleteCue, openTrash, createCue, outOfOrderCueIds, busyGroups }: { selectedCueId: string | null; state: WorkspaceState; filter: string; setFilter: (v:string) => void; openCount: (id:string)=>number; scene:(id:string)=>Scene|undefined; selectCue:(id:string)=>void; assignCueNumber:(id:string)=>void; editCueNumber:(id:string)=>void; moveCue:(id:string)=>void; showCueInScript:(id:string)=>void; assignAllCueNumbers:()=>void; deleteCue:(id:string)=>void; openTrash:()=>void; createCue:()=>void; outOfOrderCueIds: ReadonlySet<string>; busyGroups: ReadonlySet<string> }) {
  const [menuId,setMenuId] = useState<string|null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement|null>(null);
  useEffect(() => {
    if (!menuId) return;
    const outside = (event:PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuId(null); };
    const escape = (event:KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault();setMenuId(null);menuTriggerRef.current?.focus(); } };
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);
    return () => { document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape); };
  },[menuId]);
  const runMenuAction=(action:()=>void)=>{setMenuId(null);menuTriggerRef.current?.focus();action();};
  const cues = orderCuePlacements(state.cues.filter((c) => filter === "all" || (filter === "blackout" ? c.blackout : c.mode === filter)));
  const unassignedCount = state.cues.filter((cue) => !cue.number).length;
  const cueBusy = (cueId: string, groups: string[]) => groups.some((group) => busyGroups.has(`cue:${cueId}:${group}`));
  const assignAllBusy = state.cues.some((cue) => !cue.number && cueBusy(cue.id, ["assignment", "position", "lifecycle"]));
  return <div className="full-page cue-list-page"><PageHeader title="Cue list"><div className="cue-list-controls"><label className="cue-list-filter"><span>Show</span><select aria-label="Filter cues" value={filter} onChange={event=>setFilter(event.target.value)}>{(["all","unassigned","planned","implemented","blackout"] as const).map(value=><option value={value} key={value}>{value==="all"?"All cues":value==="implemented"?"Completed":value[0].toUpperCase()+value.slice(1)}</option>)}</select></label><details className="cue-list-actions"><summary>List actions</summary><div><button className="trash-button" onClick={openTrash}>Recently deleted ({state.deletedCues.length})</button>{state.cues.length>0 && <button className="assign-all-cues" disabled={unassignedCount === 0 || assignAllBusy} onClick={assignAllCueNumbers}>Assign all unnumbered ({unassignedCount})</button>}</div></details></div></PageHeader>
    {state.cues.length>0 && <div className="stat-strip five"><span><b>{state.cues.length}</b>cues</span><span className="unassigned-stat"><b>{unassignedCount}</b>unassigned</span><span><b>{state.cues.filter(c=>c.mode==="implemented").length}</b>completed</span><span className="blackout-stat"><b>{state.cues.filter(c=>c.blackout).length}</b>blackouts</span><span className="amber"><b>{state.discussions.filter(d=>!d.resolved).length}</b>open notes</span></div>}
    {cues.length===0 ? <section className="cue-list-empty"><h2>{state.cues.length===0?"No cues yet":"No cues match this filter"}</h2><p>{state.cues.length===0?"Cues are placed on the script. Choose a line or words to create your first cue.":"Your cues are still here. Show all cues to return to the complete list."}</p><button className="primary-button" onClick={state.cues.length===0?createCue:()=>setFilter("all")}>{state.cues.length===0?"Open script to place a cue":"Show all cues"}</button></section> : <div className="data-table">{cues.map((cue) => {
      const activityCount = openCount(cue.id), menuOpen = menuId===cue.id;
      return <div data-cue-id={cue.id} className={`table-row ${cue.mode} ${cue.blackout ? "blackout" : ""} ${outOfOrderCueIds.has(cue.id) ? "out-of-order" : ""} ${menuOpen?"actions-open":""}`} key={cue.id}>
        <button className="table-row-open" aria-pressed={selectedCueId === cue.id} aria-label={`Open ${cueLabel(cue)} · ${cue.title}`} onClick={() => selectCue(cue.id)} />
        <div className="cue-list-copy">
          <div className="cue-list-heading"><strong className="cue-list-number">{cueLabel(cue)}</strong><span className="cue-list-title">{cue.title}</span></div>
          <div className="cue-list-intention">{cue.description || "No lighting intention yet."}</div>
          <div className="cue-list-meta">
            <span className="cue-list-placement" title={`${scene(cue.sceneId)?.name ?? "Script"} · Page ${scriptPageNumber(cue.page)} · ${cue.anchorType === "line" ? "Line" : "Word"}`}><span>{scene(cue.sceneId)?.name ?? "Script"}</span><span>p. {scriptPageNumber(cue.page)}</span></span>
            <span className={`cue-list-status status ${cue.mode} ${cue.blackout ? "blackout" : ""}`}>{cue.blackout ? "■ Blackout · " : ""}{cue.mode === "implemented" ? "✓ Completed" : cue.mode === "unassigned" ? "○ Unassigned" : "● Planned"}</span>
            <span className={`cue-list-notes ${activityCount?"open-note":"muted"}`}>{activityCount} {activityCount===1?"note":"notes"}</span>
            {outOfOrderCueIds.has(cue.id) && <span className="order-warning" title="Cue number is out of script order">⚠ Out of order</span>}
          </div>
        </div>
        <span className="table-actions">{!cue.number && <button className="assign-cue" disabled={cueBusy(cue.id,["assignment","position","lifecycle"])} onClick={()=>assignCueNumber(cue.id)}>Assign</button>}
          <div className="cue-row-actions" ref={menuOpen?menuRef:undefined}><button type="button" aria-label={`More actions for ${cueLabel(cue)}`} aria-expanded={menuOpen} aria-controls={menuOpen?`cue-row-actions-${cue.id}`:undefined} onClick={event=>{menuTriggerRef.current=event.currentTarget;setMenuId(menuOpen?null:cue.id);}}>⋯</button>{menuOpen && <div className="cue-row-menu" id={`cue-row-actions-${cue.id}`} role="group" aria-label={`Actions for ${cueLabel(cue)}`}><button type="button" disabled={cueBusy(cue.id,["assignment","position","lifecycle"])} onClick={()=>runMenuAction(()=>editCueNumber(cue.id))}>Cue number…</button><button type="button" onClick={()=>runMenuAction(()=>showCueInScript(cue.id))}>Show in script</button><button type="button" disabled={cueBusy(cue.id,["assignment","position","lifecycle"])} onClick={()=>runMenuAction(()=>moveCue(cue.id))}>Move anchor…</button><button className="delete-cue table-delete" disabled={cueBusy(cue.id,["lifecycle"])} onClick={()=>{setMenuId(null);menuTriggerRef.current?.focus();deleteCue(cue.id);}}>Delete cue</button></div>}</div>
        </span>

      </div>;
    })}</div>}
  </div>;
}

type InboxSyncProblem = { label: string; detail: string; actionLabel: string; onAction: () => void; drafts: Array<{ label: string; value: string }> };

function InboxView({ state, active, scope, setScope, sceneFilter, setSceneFilter, typeFilter, setTypeFilter, profile, openActivity, dismiss, toggleResolved, togglePin, busyGroups, recoveryItems, getRecoveryClient, recoveryCueNames, downloadRecovery, discardRecovery, discardAllRecovery, cancelRecoveryDiscard, discardRecoveryId, syncProblem }: { state: WorkspaceState; active: Profile; scope: "for-you" | "all"; setScope: (value: "for-you" | "all") => void; sceneFilter: string; setSceneFilter: (value: string) => void; typeFilter: InboxType; setTypeFilter: (value: InboxType) => void; profile: (id?: string | null) => Profile | undefined; openActivity: (event: HistoryEvent) => void; dismiss: (eventIds: string[]) => void; toggleResolved: (discussion: Discussion) => void; togglePin: (events: HistoryEvent[]) => void; busyGroups: ReadonlySet<string>; recoveryItems: SyncRecoveryItem[]; getRecoveryClient: () => SyncV2Client | null; recoveryCueNames: Record<string, string>; downloadRecovery: (ids?: string[]) => void; discardRecovery: (item: SyncRecoveryItem) => Promise<void>; discardAllRecovery: (ids: string[]) => Promise<void>; cancelRecoveryDiscard: () => void; discardRecoveryId: string | null; syncProblem: InboxSyncProblem | null }) {
  const [pastOpen, setPastOpen] = useState(true);
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(new Set());
  const sceneGroups = useMemo(() => buildSceneGroups(state.scenes, state.document.pages, 5), [state.document.pages, state.scenes]);
  const currentHistory = useMemo(() => collapseResolutionEvents(state.history), [state.history]);
  const filtered = (scope === "all" ? state.history : currentHistory).filter((event) => {
    if (scope === "for-you" && !isActivityForProfile(event, active.id, state) && !isActivityPinned(event, active.id, state)) return false;
    if (sceneFilter !== "all" && !activitySceneIds(event, state).includes(sceneFilter)) return false;
    if (typeFilter !== "all" && activityTypeGroup(event) !== typeFilter) return false;
    return true;
  });
  const currentEvents = filtered.filter((event) => isActivityCurrent(event, active.id, state));
  const pastEvents = filtered.filter((event) => !isActivityCurrent(event, active.id, state));
  const stackPriority = (stack: InboxEventStack) => Number(stack.events.some((event) => isActivityPinned(event, active.id, state))) * 2 + Number(stack.events.some((event) => activityRequiresAction(event, state)));
  const currentStacks = stackInboxEvents(currentEvents, "current").sort((left, right) => stackPriority(right) - stackPriority(left) || right.newestAt.localeCompare(left.newestAt));
  const pastStacks = stackInboxEvents(pastEvents, "past");
  const allStacks = stackInboxEvents([...filtered].sort((left, right) => right.createdAt.localeCompare(left.createdAt)), "all");
  const dismissibleCandidates = currentEvents.filter((event) => !activityRequiresAction(event, state) && !isActivityPinned(event, active.id, state));
  const dismissible = dismissibleCandidates.some((event) => busyGroups.has(`inbox:${active.id}:${event.id}`)) ? [] : dismissibleCandidates;
  const inboxBusy = (events: HistoryEvent[]) => events.some((event) => busyGroups.has(`inbox:${active.id}:${event.id}`));
  const discussionBusy = (discussion?: Discussion) => !!discussion && busyGroups.has(`discussion:${discussion.id}`);
  const typeLabels: Record<Exclude<InboxType, "all">, string> = { notes: "NOTE", replies: "REPLY", cues: "NEW CUES", changes: "CHANGE", resolutions: "RESOLUTION", scenes: "SCENE" };
  const numberWord = (value: number) => (["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][value] ?? String(value));
  const toggleExpanded = (key: string) => setExpandedStacks((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const cueFor = (event: HistoryEvent) => event.cueId ? state.cues.find((item) => item.id === event.cueId) ?? state.deletedCues.find((item) => item.id === event.cueId)?.cue : undefined;
  const groupSummary = (stack: InboxEventStack) => {
    const actorIds = [...new Set(stack.events.map((event) => event.actorId))];
    const lead = profile(stack.events[0]?.actorId)?.name ?? "Unknown";
    const subject = actorIds.length > 1 ? `${lead} and ${numberWord(actorIds.length - 1)} ${actorIds.length === 2 ? "other" : "others"}` : lead;
    const cueCount = new Set(stack.events.map((event) => event.cueId).filter(Boolean)).size || stack.events.length;
    const sceneCount = new Set(stack.events.flatMap((event) => activitySceneIds(event, state))).size || stack.events.length;
    const cueWord = cueCount === 1 ? "cue" : "cues";
    const sceneWord = sceneCount === 1 ? "scene" : "scenes";
    const phrases: Record<ActivityType, string> = {
      legacy: `made ${stack.events.length} ${stack.events.length === 1 ? "update" : "updates"}.`,
      note_added: `added ${stack.events.length} ${stack.events.length === 1 ? "note" : "notes"}.`,
      reply_added: `added ${stack.events.length} ${stack.events.length === 1 ? "reply" : "replies"}.`,
      note_resolved: `resolved ${stack.events.length} ${stack.events.length === 1 ? "note" : "notes"}.`,
      note_reopened: `reopened ${stack.events.length} ${stack.events.length === 1 ? "note" : "notes"}.`,
      cue_created: `created ${cueCount} ${cueWord}.`,
      cue_status: `changed the status of ${cueCount} ${cueWord}.`,
      cue_number: `changed numbering on ${cueCount} ${cueWord}.`,
      cue_anchor: `moved ${cueCount} ${cueCount === 1 ? "cue anchor" : "cue anchors"}.`,
      cue_blackout: `changed blackout settings on ${cueCount} ${cueWord}.`,
      cue_edited: `edited ${cueCount} ${cueWord}.`,
      scene_owner: `changed ownership for ${sceneCount} ${sceneWord}.`,
      cue_deleted: `deleted ${cueCount} ${cueWord}.`,
      cue_restored: `restored ${cueCount} ${cueWord}.`,
    };
    return { subject, phrase: phrases[stack.events[0]?.type ?? "legacy"] };
  };
  const renderStack = (stack: InboxEventStack, placement: "current" | "past" | "all") => {
    const event = stack.events[0];
    const cue = cueFor(event);
    const discussion = stack.discussionId ? state.discussions.find((item) => item.id === stack.discussionId) : undefined;
    const sceneIds = [...new Set(stack.events.flatMap((item) => activitySceneIds(item, state)))];
    const scenes = sceneIds.map((id) => state.scenes.find((item) => item.id === id)).filter((item): item is Scene => !!item);
    const group = sceneGroups.find((item) => item.scenes.some((scene) => sceneIds.includes(scene.id)));
    const requiresAction = stack.events.some((item) => activityRequiresAction(item, state));
    const anyPinned = stack.events.some((item) => isActivityPinned(item, active.id, state));
    const read = placement === "past" || stack.events.every((item) => isActivityRead(item, active.id, state)) || !!discussion?.resolved;
    const groupName = activityTypeGroup(event);
    const isResolution = event.type === "note_resolved" || event.type === "note_reopened";
    const currentText = isResolution && discussion ? (discussion.resolved ? "resolved a note." : "reopened a note.") : event.text;
    const currentKind = isResolution && discussion ? (discussion.resolved ? "RESOLVED" : "REOPENED") : event.type === "note_added" && discussion?.resolved ? "RESOLVED NOTE" : typeLabels[groupName];
    const stackKey = `${placement}:${stack.id}`;
    const expanded = expandedStacks.has(stackKey);
    const stacked = stack.events.length > 1;
    const detailsId = `inbox-details-${stackKey.replace(/[^a-z0-9_-]/gi, "-")}`;
    const summary = groupSummary(stack);
    const metadata = cue ? `${cueLabel(cue)} · ${cue.title} · Page ${scriptPageNumber(cue.page)}` : group ? `Scenes ${group.number} · ${group.name}` : scenes.length ? `${scenes.length === 1 ? "Scene" : "Scenes"} ${scenes.map((scene) => scene.number).join(", ")}` : "Workspace activity";
    const canDismiss = scope === "for-you" && placement === "current" && !requiresAction;
    return <div className={`inbox-stack-shell ${stacked ? "stacked" : ""} ${expanded ? "expanded" : ""}`} key={stackKey}>
      <article className={`inbox-event ${groupName} ${read ? "read" : "unread"} ${requiresAction ? "action-required" : "informational"} ${anyPinned ? "pinned" : ""} ${discussion?.resolved ? "note-resolved" : "note-open"}`}>
        <button className="inbox-event-open" aria-label={stacked ? (expanded ? "Collapse grouped updates" : "Expand grouped updates") : `Open ${currentKind.toLowerCase()} in script`} aria-expanded={stacked ? expanded : undefined} aria-controls={stacked ? detailsId : undefined} onClick={() => stacked ? toggleExpanded(stackKey) : openActivity(event)} />
        <span className="unread-dot" aria-label={read ? "Dismissed" : "Current"} />
        <div className="activity-kind">{currentKind}</div>
        <ProfileMark profile={profile(event.actorId)} small />
        <div className="activity-copy"><div className={`activity-requirement ${requiresAction ? "action" : "update"}`}>{requiresAction ? "ACTION REQUIRED" : stacked ? `${stack.events.length} UPDATES` : "UPDATE"}</div><p className="activity-context"><strong>{metadata}</strong></p>{discussion && !stacked && <blockquote>{event.type === "reply_added" ? discussion.replies.find((reply) => reply.id === event.replyId)?.content ?? discussion.content : discussion.content}</blockquote>}<p className="activity-author">{stacked ? <><strong>{summary.subject}</strong> {summary.phrase}</> : <><strong>{profile(event.actorId)?.name ?? "Unknown"}</strong> {currentText}</>}</p><span className="activity-time">{timeAgo(stack.newestAt)}</span></div>
        <div className="inbox-event-actions">{discussion && !stacked && <button type="button" className="inbox-read-thread" onClick={click=>{click.stopPropagation();openActivity(event);}}>Open thread</button>}{discussion && <button className="inbox-resolve" disabled={discussionBusy(discussion)} onClick={(click) => { click.stopPropagation(); toggleResolved(discussion); }}>{discussion.resolved ? "Reopen" : "Resolve"}</button>}<button className={`inbox-pin ${anyPinned ? "active" : ""}`} disabled={inboxBusy(stack.events)} aria-label={anyPinned ? "Unpin notification" : "Pin notification"} title={anyPinned ? "Unpin" : "Pin"} aria-pressed={anyPinned} onClick={(click) => { click.stopPropagation(); togglePin(stack.events); }}><span className="pin-glyph" aria-hidden="true" /></button>{canDismiss && <button className="inbox-dismiss" aria-label="Dismiss update to Past" title={anyPinned ? "Unpin before dismissing" : "Dismiss to Past"} disabled={anyPinned || inboxBusy(stack.events)} onClick={(click) => { click.stopPropagation(); dismiss(stack.events.map((item) => item.id)); }}>×</button>}</div>
        <span className={`inbox-open-label ${stacked ? "grouped" : ""}`} aria-hidden="true">{stacked ? (expanded ? "↑" : "↓") : "→"}</span>
      </article>
      {stacked && expanded && <div className="inbox-stack-details" id={detailsId}>{stack.events.map((item) => { const itemCue = cueFor(item); const itemDiscussion = item.discussionId ? state.discussions.find((candidate) => candidate.id === item.discussionId) : undefined; const itemReply = itemDiscussion?.replies.find((reply) => reply.id === item.replyId); const itemPinned = isActivityPinned(item, active.id, state); return <article className={`inbox-stack-detail ${itemPinned ? "pinned" : ""}`} key={item.id}><button className="inbox-stack-detail-open" aria-label="Open update in script" onClick={() => openActivity(item)} /><ProfileMark profile={profile(item.actorId)} small /><span><strong>{profile(item.actorId)?.name ?? "Unknown"}</strong> {item.text}{(itemReply || itemDiscussion) && <em>{itemReply?.content ?? itemDiscussion?.content}</em>}<small>{itemCue ? `${cueLabel(itemCue)} · ${itemCue.title} · Page ${scriptPageNumber(itemCue.page)}` : timeAgo(item.createdAt)}</small></span><div className="inbox-stack-detail-actions">{itemDiscussion && <button className="inbox-resolve" disabled={discussionBusy(itemDiscussion)} onClick={() => toggleResolved(itemDiscussion)}>{itemDiscussion.resolved ? "Reopen" : "Resolve"}</button>}<button className={`inbox-pin ${itemPinned ? "active" : ""}`} disabled={inboxBusy([item])} aria-label={itemPinned ? "Unpin this update" : "Pin this update"} title={itemPinned ? "Unpin" : "Pin"} aria-pressed={itemPinned} onClick={() => togglePin([item])}><span className="pin-glyph" aria-hidden="true" /></button></div><i aria-hidden="true">→</i></article>; })}</div>}
    </div>;
  };
  const hasAttentionCard = recoveryItems.length > 0 || !!syncProblem;
  const displayedCurrentCount = (scope === "for-you" ? currentStacks.length : 0) + Number(hasAttentionCard);
  const attentionCard = recoveryItems.length > 0
    ? <SyncRecoveryInbox getClient={getRecoveryClient} items={recoveryItems} cueNames={recoveryCueNames} state={state} actorId={active.id} onDownload={downloadRecovery} onDiscard={discardRecovery} onDiscardAll={discardAllRecovery} onCancelDiscard={cancelRecoveryDiscard} discardId={discardRecoveryId} />
    : syncProblem && <div className="inbox-stack-shell recovery-stack" id="inbox-sync-problem-card" tabIndex={-1}><article className="inbox-event recovery unread action-required pinned"><span className="unread-dot" aria-label="Sync needs attention" /><div className="activity-kind">SYNC</div><span className="recovery-device-mark" aria-hidden="true">!</span><div className="activity-copy"><div className="activity-requirement action">ACTION REQUIRED</div><p><strong>{syncProblem.label}</strong></p><span>{syncProblem.detail}</span></div><div className="inbox-event-actions"><button className="inbox-resolve" onClick={syncProblem.onAction}>{syncProblem.actionLabel}</button></div></article>{syncProblem.drafts.length > 0 && <div className="recovery-group-body"><p>Keep this tab open. Copy unsaved drafts before refreshing or closing it.</p><div className="recovery-group-actions">{syncProblem.drafts.map((draft) => <button type="button" key={draft.label} onClick={() => void navigator.clipboard.writeText(draft.value)}>Copy {draft.label.toLowerCase()}</button>)}</div></div>}</div>;
  return <div className="full-page inbox-page">
    <PageHeader eyebrow="TEAM ACTIVITY" title="Inbox">{scope === "for-you" && <button className="mark-all-read" disabled={!dismissible.length} onClick={() => dismiss(dismissible.map((event) => event.id))}>Dismiss visible updates</button>}</PageHeader>
    <div className="inbox-controls"><div className="segmented"><button aria-pressed={scope === "for-you"} className={scope === "for-you" ? "active" : ""} onClick={() => setScope("for-you")}>For you</button><button aria-pressed={scope === "all"} className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>All activity</button></div><label><span>Scene</span><select aria-label="Filter inbox by scene" value={sceneFilter} onChange={(event) => setSceneFilter(event.target.value)}><option value="all">All scenes</option>{state.scenes.map((scene) => <option key={scene.id} value={scene.id}>Scene {scene.number} · {scene.name}</option>)}</select></label><label><span>Type</span><select aria-label="Filter inbox by type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as InboxType)}><option value="all">All types</option><option value="notes">Notes</option><option value="replies">Replies</option><option value="cues">New cues</option><option value="changes">Cue changes</option><option value="resolutions">Resolutions</option><option value="scenes">Scene ownership</option></select></label></div>
    <details className="inbox-help"><summary>How Inbox works</summary><p className="inbox-explanation">{scope === "for-you" ? "Current only groups non-action cue and scene updates within 12 hours. Required notes and replies remain individual; Past groups every matching activity type." : "A shared activity record for the whole team. Every matching activity type can form a 12-hour stack, including notes and replies."}</p></details>
    {(scope === "for-you" || hasAttentionCard) && <section className="inbox-section current-section"><header><div><span>CURRENT</span><strong>Needs action, explicit dismissal, or is pinned</strong></div><b>{displayedCurrentCount}</b></header><div className="inbox-list">{attentionCard}{scope === "for-you" && currentStacks.map((stack) => renderStack(stack, "current"))}{displayedCurrentCount === 0 && <div className="empty-inbox compact"><span>✓</span><strong>Nothing needs your attention.</strong><small>New updates, unresolved notes, and pins will appear here.</small></div>}</div></section>}
    {scope === "all" ? <section className="inbox-section all-activity-section"><div className="inbox-list">{allStacks.map((stack) => renderStack(stack, "all"))}{allStacks.length === 0 && <div className="empty-inbox compact"><span>✓</span><strong>No activity matches these filters.</strong><small>Try widening the scene or activity filters.</small></div>}</div></section> : <section className="inbox-section past-section"><button className="inbox-section-toggle" aria-expanded={pastOpen} onClick={() => setPastOpen((open) => !open)}><span><b>PAST</b><small>Dismissed updates and completed items · grouped within 12 hours</small></span><strong>{pastStacks.length}</strong><i>{pastOpen ? "−" : "+"}</i></button>{pastOpen && <div className="inbox-list">{pastStacks.map((stack) => renderStack(stack, "past"))}{pastStacks.length === 0 && <div className="empty-inbox compact"><span>◇</span><strong>No past notifications yet.</strong><small>Dismissed updates will move here.</small></div>}</div>}</section>}
  </div>;
}

function ScenesView({ state, profile, claimSceneGroup, unassignSceneGroup, activeId, focusedSceneId, openSceneInScript, assignGroupCueNumbers, busyGroups }: { state:WorkspaceState; profile:(id?:string|null)=>Profile|undefined; claimSceneGroup:(sceneIds:string[])=>void; unassignSceneGroup:(sceneIds:string[])=>void; activeId:string; focusedSceneId:string|null; openSceneInScript:(scene:Scene)=>void; assignGroupCueNumbers:(sceneIds:string[])=>void; busyGroups: ReadonlySet<string> }) {
  const [expandedGroups,setExpandedGroups] = useState<Set<string>>(new Set());
  const groups = useMemo(() => buildSceneGroups(state.scenes, state.document.pages, 5), [state.document.pages, state.scenes]);

  useEffect(() => {
    if (!focusedSceneId) return;
    const group = groups.find((item) => item.scenes.some((scene) => scene.id === focusedSceneId));
    const timer = window.setTimeout(() => document.getElementById(`scene-group-row-${group?.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 40);
    return () => window.clearTimeout(timer);
  }, [focusedSceneId, groups]);

  const assignedGroups = groups.filter((group) => group.scenes.some((scene) => scene.ownerId)).length;
  return <div className="full-page"><PageHeader eyebrow={desktopMode ? "SHOW" : "ASSIGNMENT"} title={desktopMode ? "Scenes" : "Scene ownership"}><p className="header-note">{groups.length} grouped sections of at least 5 pages · {desktopMode ? `${state.scenes.length} scenes` : `${assignedGroups} assigned`}</p></PageHeader><div className="scene-list grouped-scenes">{groups.map((group) => {
    const sceneIds = new Set(group.scenes.map((scene) => scene.id));
    const cues = state.cues.filter((cue) => {
      const derivedScene = sceneAtPosition(state.scenes, cue.page, cue.anchorY ?? 0);
      return !!derivedScene && sceneIds.has(derivedScene.id);
    });
    const cueIds = new Set(cues.map((cue) => cue.id));
    const done = cues.filter((cue) => cue.mode === "implemented").length;
    const open = state.discussions.filter((discussion) => !discussion.resolved && (discussion.cueId ? cueIds.has(discussion.cueId) : discussion.sceneId ? sceneIds.has(discussion.sceneId) : false)).length;
    const ownerIds = [...new Set(group.scenes.map((scene) => scene.ownerId))];
    const ownerId = ownerIds.length > 1 ? "mixed" : ownerIds[0] ?? null;
    const target = group.scenes[0];
    const focused = !!focusedSceneId && group.scenes.some((scene) => scene.id === focusedSceneId);
    const sceneIdsList = group.scenes.map((scene) => scene.id);
    const ownerBusy = sceneIdsList.some((sceneId) => busyGroups.has(`scene:${sceneId}:owner`));
    const unnumbered = cues.filter((cue) => !cue.number);
    const numberingBusy = unnumbered.some((cue) => ["assignment", "position", "lifecycle"].some((field) => busyGroups.has(`cue:${cue.id}:${field}`)));
    const expanded = expandedGroups.has(group.id);
    return <article id={`scene-group-row-${group.id}`} className={`scene-row scene-group-row ${focused ? "focused" : ""}`} key={group.id}><div className="scene-identity"><span>SCENES {group.number}</span><h2>{group.name}</h2><small>PAGES {scriptPageNumber(group.pageStart)}–{scriptPageNumber(group.pageEnd)} · {group.scenes.length} {group.scenes.length===1 ? "scene" : "scenes"}</small><button type="button" className="scene-group-disclosure" aria-label={`${expanded ? "Hide" : "Show"} scenes in ${group.name}`} aria-expanded={expanded} aria-controls={`scene-members-${group.id}`} onClick={()=>setExpandedGroups(current=>{const next=new Set(current);if(next.has(group.id))next.delete(group.id);else next.add(group.id);return next;})}>{expanded?"Hide scenes":`Show ${group.scenes.length} ${group.scenes.length===1?"scene":"scenes"}`} {expanded?"⌃":"⌄"}</button></div><div className="owner-row">{ownerId ? <><ProfileMark profile={profile(ownerId)} /><span><small>GROUP OWNER</small><strong>{profile(ownerId)?.name}</strong></span></> : <><button className="unassigned-mark" disabled={ownerBusy} aria-label={`Claim Scenes ${group.number}`} onClick={()=>claimSceneGroup(sceneIdsList)}>＋</button><span><small>GROUP OWNER</small><strong>Unassigned</strong></span></>}<span className="scene-owner-actions"><button disabled={ownerBusy || ownerId === activeId} onClick={()=>claimSceneGroup(sceneIdsList)}>{ownerId === activeId ? "Owned by you" : ownerId ? "Assign entire group to me" : "Claim entire group"}</button>{ownerId && <button className="unassign-scene" disabled={ownerBusy} onClick={()=>unassignSceneGroup(sceneIdsList)}>Unassign entire group</button>}</span></div><div className="progress"><div><span style={{width:`${cues.length ? (done/cues.length)*100 : 0}%`}} /></div><p>{cues.length ? <><b>{done}</b> of {cues.length} implemented</> : "No cues yet"} <span>{open} open notes</span></p></div><div className="scene-row-actions"><div className="scene-numbering"><button disabled={unnumbered.length === 0 || numberingBusy} title="Assign numbers to unnumbered cues across this group. Existing numbers stay the same." onClick={() => assignGroupCueNumbers(sceneIdsList)}>Auto-number group ({unnumbered.length})</button><small>Unnumbered cues only</small></div><button className="view-scene scene-row-open" aria-label={`Open Scenes ${group.number}, ${group.name}, in script`} onClick={()=>openSceneInScript(target)}>Open script →</button></div>{expanded && <section className="scene-group-details" id={`scene-members-${group.id}`} aria-label={`Scenes in ${group.name}`}>{group.scenes.map(member=><article className="scene-member" key={member.id}><button type="button" onClick={()=>openSceneInScript(member)}><strong>Scene {member.number} · {member.name}</strong><small>Pages {scriptPageNumber(member.pageStart)}–{scriptPageNumber(member.pageEnd)}</small></button><span className="scene-member-owner">{member.ownerId && <ProfileMark profile={profile(member.ownerId)} small/>}<span>{member.ownerId?profile(member.ownerId)?.name??"Unknown owner":"Unassigned"}</span></span></article>)}</section>}</article>;
  })}</div></div>;
}

function BackupControl({ available }: { available: boolean }) {
  const [status, setStatus] = useState<"idle" | "preparing" | "ready" | "error">("idle");
  const [manifest, setManifest] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const prepare = async () => {
    if (desktopMode) {
      try { if (await window.desktopFlush?.()) { await window.desktop.save(true); setMessage("Show file saved."); } } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save the show."); }
      return;
    }
    setStatus("preparing");
    setMessage(syncNotice("N36", { completed: 0, total: 1 }));
    try {
      const preparedResponse = await fetch("/api/backup/exports", { method: "POST", headers: { accept: "application/json" } });
      if (!preparedResponse.ok) throw new Error("The backup snapshot could not be prepared.");
      const prepared = await preparedResponse.json() as { manifestUrl?: string };
      if (!prepared.manifestUrl) throw new Error("The backup manifest link is missing.");
      const manifestResponse = await fetch(prepared.manifestUrl, { cache: "no-store", headers: { accept: "application/json" } });
      if (!manifestResponse.ok) throw new Error("The backup manifest could not be verified.");
      const value = await manifestResponse.json() as Record<string, unknown>;
      if (value.format !== "lighting-dashboard-backup-v2" || value.status !== "ready") throw new Error("The server returned an incomplete backup manifest.");
      setManifest(value);
      setStatus("ready");
      setMessage("The fixed snapshot is ready. Downloading this manifest alone is not a complete backup; the command below verifies every part and the PDF.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "The backup could not be prepared.");
    }
  };
  const downloadManifest = () => {
    if (!manifest) return;
    const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sync-v2-${String(manifest.exportId ?? "backup")}-server-manifest.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const command = typeof window === "undefined" ? "pnpm sync:export -- --base-url <dashboard-url> --output sync-v2-backup" : `pnpm sync:export -- --base-url ${window.location.origin} --output sync-v2-backup`;
  return <div className="backup-settings"><span><strong>{desktopMode ? "Show file" : "Database backup"}</strong><small>{desktopMode ? "Save the script, cues, notes, and history together in a portable .lxshow file." : "Prepare one fixed Sync v2 snapshot, then download and verify its paged records and PDF with the local export tool."}</small>{message && <em role={status === "error" ? "alert" : "status"}>{message}</em>}{status === "ready" && <code>{command}</code>}</span><div><button type="button" disabled={!available || status === "preparing"} onClick={() => void prepare()}>{status === "preparing" ? "Preparing…" : desktopMode ? "Save show as…" : "Prepare backup"}</button>{manifest && <button type="button" onClick={downloadManifest}>Download manifest</button>}</div></div>;
}

function ProfileSettingsDialog({ readingPreferences, setReadingPreferences, profiles, draft, setDraft, beginEdit, save, theme, setTheme, backupAvailable, busyGroups, close }: { readingPreferences: ScriptReadingPreferences; setReadingPreferences: (patch: Partial<ScriptReadingPreferences>) => void; profiles: Profile[]; draft: Profile | null; setDraft: (profile: Profile | null) => void; beginEdit: (profile?: Profile) => void; save: () => void; theme: ThemePreference; setTheme: (theme: ThemePreference) => void; backupAvailable: boolean; busyGroups: ReadonlySet<string>; close: () => void }) {
  const [section, setSection] = useState<"profiles" | "preferences" | "backup">(desktopMode ? "preferences" : "profiles");
  const hue = draft ? hexToHue(draft.color) : 205;
  const profileBusy = !!draft && busyGroups.has(`profile:${draft.id}`);
  return <ModalShell className="settings-dialog" labelledBy="profile-settings-title" onClose={close} closeOnBackdrop>
    <header><div><span>SETTINGS</span><h2 id="profile-settings-title">Workspace settings</h2></div><button aria-label="Close settings" onClick={close}>×</button></header>
    {!draft && !desktopMode && <nav className="settings-sections" aria-label="Settings sections">{(["profiles", "preferences", "backup"] as const).filter(item => !desktopMode || item !== "profiles").map((item) => <button key={item} className={section === item ? "active" : ""} aria-current={section === item ? "page" : undefined} onClick={() => setSection(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>}
    {draft ? <div className="profile-editor"><div className="profile-editor-preview"><ProfileMark profile={draft} /><span><strong>{draft.name || "New profile"}</strong><small>{draft.role || "Role"}</small></span></div><label><span>Name</span><input maxLength={FIELD_LIMITS.profileName} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Profile name" /></label><label><span>Role</span><input maxLength={FIELD_LIMITS.profileRole} value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} placeholder="Lighting Team" /></label><div className="profile-editor-row"><label><span>Initials</span><input maxLength={FIELD_LIMITS.profileInitials} value={draft.initials} onChange={(event) => setDraft({ ...draft, initials: event.target.value.toUpperCase() })} placeholder="NG" /></label><label className="spectrum-control"><span>Profile color</span><input type="range" min="0" max="359" value={hue} aria-label="Profile color spectrum" aria-valuetext={`Hue ${hue} degrees`} onChange={(event) => setDraft({ ...draft, color: hueToHex(Number(event.target.value)) })} /><small><i style={{ background: draft.color }} />Drag through the spectrum</small></label></div><footer><button onClick={() => setDraft(null)}>Cancel</button><button className="primary-button" disabled={profileBusy || !draft.name.trim() || !draft.role.trim() || !draft.initials.trim()} onClick={save}>Save profile</button></footer></div>
      : section === "profiles" ? <div className="profile-settings-list">{profiles.map((item) => <button key={item.id} style={{ "--profile": item.color } as React.CSSProperties} onClick={() => beginEdit(item)}><ProfileMark profile={item} /><span><strong>{item.name}</strong><small>{item.role}</small></span><em>Edit</em></button>)}<button className="add-profile-row" onClick={() => beginEdit()}><span>＋</span><strong>Add profile</strong></button></div>
      : section === "preferences" ? <div className="preferences-settings"><section><span><strong>Appearance</strong><small>Choose how this browser displays the workspace.</small></span><div className="theme-options" role="radiogroup" aria-label="Appearance">{(["dark", "light"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={theme === value} className={theme === value ? "active" : ""} onClick={() => setTheme(value)}><i className={`theme-preview ${value}`} />{value[0].toUpperCase() + value.slice(1)}</button>)}</div></section><section className="script-reading-settings"><span><strong>Script reading</strong></span><div className="reading-preference-fields"><label><input type="checkbox" checked={readingPreferences.pages} onChange={event => setReadingPreferences({ pages:event.target.checked })} /> Pages</label><label>Typeface<select aria-label="Script typeface" value={readingPreferences.font} onChange={event => setReadingPreferences({ font:event.target.value as "serif" | "sans" | "source" })}>{desktopMode && <option value="source">Script fonts</option>}<option value="serif">Serif</option><option value="sans">Sans</option></select></label><label>Base size<select aria-label="Script font size" value={readingPreferences.size} onChange={event => setReadingPreferences({ size:Number(event.target.value) })}>{[16,18,20,22,24,26].map(size => <option key={size} value={size}>{size} px</option>)}</select></label><label>Spacing<select aria-label="Script line spacing" value={readingPreferences.leading} onChange={event => setReadingPreferences({ leading:Number(event.target.value) })}><option value={1.4}>Tight</option><option value={1.5}>Normal</option><option value={1.65}>Relaxed</option><option value={1.9}>Airy</option></select></label></div></section><section><span><strong>Search shortcut</strong><small>Press ⌘K on Mac or Ctrl+K elsewhere to open search.</small></span></section></div>
      : <BackupControl available={backupAvailable} />}
  </ModalShell>;
}

function DeleteCueDialog({ cue, notes, scene, busy, cancel, confirm }: { cue?: Cue; notes: Discussion[]; scene: (id: string) => Scene | undefined; busy: boolean; cancel: () => void; confirm: () => void }) {
  if (!cue) return null;
  const replies = notes.reduce((total, note) => total + note.replies.length, 0);
  return <ModalShell className="confirm-dialog" role="alertdialog" labelledBy="delete-cue-title" onClose={cancel}><header><span>RECOVERABLE DELETION</span><h2 id="delete-cue-title">Move this cue to Recently deleted?</h2></header><div className="delete-cue-summary"><strong>{cueLabel(cue)} · {cue.title}</strong><span>{scene(cue.sceneId)?.name} · Page {scriptPageNumber(cue.page)}</span><small>{notes.length} {notes.length === 1 ? "note" : "notes"} · {replies} {replies === 1 ? "reply" : "replies"}</small></div><p>The cue, its anchor, and its discussion will be hidden from the production workspace. You can restore everything later.</p><footer><button data-autofocus disabled={busy} onClick={cancel}>Cancel</button><button className="confirm-delete" disabled={busy} onClick={confirm}>{busy ? "Saving cue edits…" : "Move to Recently deleted"}</button></footer></ModalShell>;
}

function RecentlyDeletedDialog({ focusCueId, deleted, profile, restore, busyGroups, close }: { focusCueId: string | null; deleted: WorkspaceState["deletedCues"]; profile: (id?: string | null) => Profile | undefined; restore: (cueId: string) => void; busyGroups: ReadonlySet<string>; close: () => void }) {
  useEffect(() => { if (focusCueId) { const timer = window.setTimeout(() => { const item = document.getElementById(`deleted-cue-${focusCueId}`); item?.scrollIntoView({ block: "center" }); item?.focus(); }, 0); return () => window.clearTimeout(timer); } }, [focusCueId]);
  return <ModalShell className="trash-dialog" labelledBy="recently-deleted-title" onClose={close} closeOnBackdrop><header><div><span>RECOVERY</span><h2 id="recently-deleted-title">Recently deleted cues</h2></div><button aria-label="Close Recently deleted" onClick={close}>×</button></header>{deleted.length ? <div className="trash-list">{deleted.map((item) => <article id={`deleted-cue-${item.id}`} tabIndex={-1} className={focusCueId === item.id ? "activity-target" : ""} key={item.id}><div><strong>{cueLabel(item.cue)} · {item.cue.title}</strong><span>Page {scriptPageNumber(item.cue.page)} · {item.discussions.length} attached {item.discussions.length === 1 ? "note" : "notes"}</span><small>Deleted by {profile(item.deletedBy)?.name ?? "Unknown"} · {timeAgo(item.deletedAt)}</small></div><button disabled={busyGroups.has(`cue:${item.id}:lifecycle`)} onClick={() => restore(item.id)}>Restore cue</button></article>)}</div> : <div className="empty-trash"><span>✓</span><strong>Nothing has been deleted.</strong><small>Removed cues will be recoverable here.</small></div>}</ModalShell>;
}

function PreferenceStorageNotice({ editingPaused }: { editingPaused: boolean }) {
  return <aside className="preference-storage-warning" role="alert"><strong>Browser storage is unavailable.</strong><span> Preferences may reset when you reload.{editingPaused ? " Editing is paused until local changes can be saved safely." : " Your preferences will apply for this tab."}</span></aside>;
}
