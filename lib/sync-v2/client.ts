import { formatCueNumber, normalizeCueNumbers } from "../cue-numbering.ts";
import type { WorkspaceState } from "../types.ts";
import { base64ToBytes, bytesToBase64 } from "./encoding.ts";
import { SyncClientStore, type PendingOperationRecord, type SyncDraftRecord, type SyncRecoveryItem, type TextJournalRecord, type TextValues } from "./client-store.ts";
import { SYNC_FRESHNESS_MS, SYNC_POLL_MS, SYNC_PROBE_TIMEOUT_MS, TEXT_SEND_IDLE_MS, TEXT_SEND_MAX_WAIT_MS, VISIBLE_TEXT_POLL_MS, retryDelay } from "./config.ts";
import { actionTargetId, MAX_SYNC_REQUEST_BYTES, SYNC_PROTOCOL, SYNC_WORKSPACE_ID, type ConnectionState, type OperationEnvelope, type OperationResult, type SaveState, type SyncAction, type SyncEvent, type SyncNoticeRecord } from "./protocol.ts";
import { operationNotice, syncNotice } from "./notifications.ts";
import { textRecoveryPlan, TEXT_FIELDS } from "./text-recovery.ts";
import type { ProjectionVersions } from "./reducer.ts";

type YjsModule = typeof import("yjs");
let yjsPromise: Promise<YjsModule> | null = null;
const OFFLINE_CACHE_VERSION = "sync-v2-45";
const SYNC_DIAGNOSTICS_FLAG = "lt-feature-sync-v2-diagnostics";

// The bundled main-process service remains reachable when the network is offline.
function transportAvailable() { return !!globalThis.window?.desktop || navigator.onLine; }

function syncDiagnosticsEnabled() {
  try { return localStorage.getItem(SYNC_DIAGNOSTICS_FLAG) === "on"; }
  catch { return false; }
}

function pendingDiagnostic(record: PendingOperationRecord) {
  return {
    operationId: record.operationId,
    action: record.envelope.action.type,
    targetId: record.targetId ?? null,
    dependsOn: record.envelope.dependsOn,
    createdAt: record.createdAt,
    attempts: record.attempts,
    lastError: record.lastError ?? null,
  };
}

function resultDiagnostic(result: OperationResult) {
  const outcome = result.outcome ?? {};
  const safeOutcome = Object.fromEntries(Object.entries(outcome).filter(([key]) => [
    "dependency", "cueId", "discussionId", "noticeId", "number", "requested",
    "currentRevision", "retryAfterMs", "targetId",
  ].includes(key)));
  return {
    operationId: result.operationId,
    status: result.status,
    code: result.code ?? null,
    message: result.message ?? null,
    sequence: result.sequence ?? null,
    outcome: safeOutcome,
  };
}

function traceSync(event: string, value: unknown) {
  if (!syncDiagnosticsEnabled()) return;
  console.warn(`[sync-v2] ${event} ${JSON.stringify(value)}`);
}

export function orderPendingOperations(records: PendingOperationRecord[]) {
  const byId = new Map(records.map((record) => [record.operationId, record]));
  const dependents = new Map<string, string[]>();
  const localDependencyCount = new Map<string, number>();
  for (const record of records) {
    const localDependencies = [...new Set(record.envelope.dependsOn)].filter((id) => byId.has(id));
    localDependencyCount.set(record.operationId, localDependencies.length);
    for (const dependency of localDependencies) {
      dependents.set(dependency, [...dependents.get(dependency) ?? [], record.operationId]);
    }
  }
  const ready = records.filter((record) => localDependencyCount.get(record.operationId) === 0);
  const ordered: PendingOperationRecord[] = [];
  for (let index = 0; index < ready.length; index += 1) {
    const record = ready[index];
    ordered.push(record);
    for (const dependentId of dependents.get(record.operationId) ?? []) {
      const next = (localDependencyCount.get(dependentId) ?? 0) - 1;
      localDependencyCount.set(dependentId, next);
      if (next === 0) ready.push(byId.get(dependentId)!);
    }
  }
  const orderedIds = new Set(ordered.map((record) => record.operationId));
  return { ordered, blocked: records.filter((record) => !orderedIds.has(record.operationId)) };
}

function loadYjs() {
  yjsPromise ??= import("yjs");
  return yjsPromise;
}

export type BootstrapPayload = {
  protocol: 2;
  workspaceId: string;
  epoch: string;
  sequence: number;
  writeMode: "legacy" | "enabled" | "read_only";
  serverTime: string;
  state: WorkspaceState;
  versions: ProjectionVersions;
  textDocuments: Array<{ cueId: string; revision: number; sequence: number; hash: string }>;
  notices: SyncNoticeRecord[];
};

type TextSession = {
  cueId: string;
  document: import("yjs").Doc;
  revision: number;
  hash: string | null;
  baseStateVector: Uint8Array;
  updates: Uint8Array[];
  journal: TextJournalRecord[];
  startedAt: number;
  timer: number | null;
  pendingDependencies: string[];
  actorId: string;
  composing: boolean;
  undoManager: import("yjs").UndoManager;
};

type TextPayload = { epoch?: string; revision: number; encodedState: string; stateVector: string; hash?: string };
type TextField = "title" | "description" | "technicalNotes";

export type SyncClientCallbacks = {
  onBootstrap(value: BootstrapPayload, source: "server" | "cache"): void;
  onConnection(state: ConnectionState): void;
  onSave(state: SaveState): void;
  onError(message: string | null): void;
  onText(cueId: string, field: TextField, value: string): void;
  onPending(count: number): void;
  onBusyGroups(groups: string[]): void;
  onRecovery(items: SyncRecoveryItem[]): void;
  onDrafts(items: SyncDraftRecord[]): void;
  onRemoteText(cueId: string, field: TextField): void;
  onOfflineCache(ready: boolean): void;
};

function replaceText(text: import("yjs").Text, value: string) {
  const current = text.toString();
  let prefix = 0;
  while (prefix < current.length && prefix < value.length && current[prefix] === value[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < current.length - prefix && suffix < value.length - prefix && current[current.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix += 1;
  const remove = current.length - prefix - suffix;
  const insert = value.slice(prefix, value.length - suffix);
  if (remove) text.delete(prefix, remove);
  if (insert) text.insert(prefix, insert);
}

function textValues(document: import("yjs").Doc): TextValues {
  return {
    title: document.getText("title").toString(),
    description: document.getText("description").toString(),
    technicalNotes: document.getText("technicalNotes").toString(),
  };
}

export function syncActionGroups(action: SyncAction) {
  if (action.type === "applyTextUpdate" || action.type === "acknowledgeNotice") return [];
  if (action.type === "restoreTextVersion") return [`cue:${action.cueId}:text`];
  if (action.type === "setSceneOwners") return action.scenes.map((scene) => `scene:${scene.sceneId}:owner`);
  if (action.type === "assignCueNumbers") return action.cues.flatMap((cue) => [`cue:${cue.cueId}:assignment`, `cue:${cue.cueId}:position`, `cue:${cue.cueId}:lifecycle`]);
  if (action.type === "createOrUpdateProfile") return [`profile:${action.profile.id}`];
  if (action.type === "addNote") return [`discussion:${action.discussion.id}`];
  if (action.type === "addReply" || action.type === "setDiscussionResolved") return [`discussion:${action.discussionId}`];
  if (action.type === "setInboxRead" || action.type === "setInboxPinned") return action.eventIds.map((id) => `inbox:${action.profileId}:${id}`);
  if (action.type === "createCue") return [`cue:${action.cue.id}:lifecycle`];
  const groups: string[] = [];
  if (["assignNextNumber", "setCueNumber", "unassignCue", "setCueMode"].includes(action.type)) groups.push(`cue:${action.cueId}:assignment`);
  if (action.type === "setBlackout") groups.push(`cue:${action.cueId}:blackout`);
  if (action.type === "moveCue") groups.push(`cue:${action.cueId}:position`, `cue:${action.cueId}:assignment`);
  if (action.type === "deleteCue" || action.type === "restoreCue") groups.push(`cue:${action.cueId}:lifecycle`);
  return groups;
}

export function recoveryItemGroups(item: SyncRecoveryItem) {
  if (item.envelope) return syncActionGroups(item.envelope.action);
  if (item.targetId && ["composition-fragment", "volatile-unsaved-text"].includes(item.kind ?? "")) return [`cue:${item.targetId}:text`];
  return [];
}

export class SyncV2Client {
  private store: SyncClientStore | null = null;
  private bootstrap: BootstrapPayload | null = null;
  private connection: ConnectionState = "starting";
  private lastFreshAt = 0;
  private sessionId = crypto.randomUUID();
  private journalOrder = 0;
  private textSessions = new Map<string, TextSession>();
  private channel: BroadcastChannel | null = null;
  private stopped = false;
  private pollTimer: number | null = null;
  private visibleTextCueId: string | null = null;
  private visibleTextPollTimer: number | null = null;
  private visibleTextRefresh: Promise<void> | null = null;
  private recovering = false;
  private retryAttempt = 0;
  private retryTimer: number | null = null;
  private freshnessTimer: number | null = null;
  private refreshPromise: Promise<void> | null = null;
  private refreshAgain = false;
  private prepareTextPromises = new Map<string, Promise<TextSession | null>>();
  private textEditQueues = new Map<string, Promise<boolean>>();
  private textEditValues = new Map<string, Partial<Record<TextField, string>>>();
  private textSealQueues = new Map<string, Promise<void>>();
  private sendPromises = new Map<string, Promise<OperationResult | null>>();
  private runtimeAttached = false;
  private inFlightGroups = new Set<string>();
  private sequenceBarriers = new Map<string, number>();
  private blockedTargets = new Set<string>();
  private blockedGroups = new Set<string>();
  private remoteHintGeneration = 0;
  private reportedBusyGroups = "";
  private readonly resume = () => {
    if (document.visibilityState !== "visible" || !transportAvailable()) return;
    if (!this.canEdit) this.closeEditGate("checking");
    void this.refresh();
  };
  private readonly visibilityChange = () => {
    if (document.visibilityState === "visible") this.resume();
    else {
      this.closeEditGate("checking");
      for (const session of this.textSessions.values()) if (session.updates.length) void this.sealText(session, session.actorId, false);
    }
  };
  private readonly lostConnection = () => {
    if (globalThis.window?.desktop) return;
    this.closeEditGate("offline");
    for (const session of this.textSessions.values()) if (session.updates.length) void this.sealText(session, session.actorId, false);
  };
  private readonly pagehide = () => {
    this.closeEditGate("checking");
    for (const session of this.textSessions.values()) if (session.updates.length) void this.sealText(session, session.actorId, false);
  };
  private readonly pageshow = () => this.resume();

  constructor(private readonly callbacks: SyncClientCallbacks) {}

  get active() { return this.bootstrap?.writeMode === "enabled"; }
  get currentBootstrap() { return this.bootstrap; }
  get connectionState() { return this.connection; }
  get canEdit() {
    return this.active && this.connection === "online" && performance.now() - this.lastFreshAt <= SYNC_FRESHNESS_MS && document.visibilityState === "visible" && !!this.store;
  }

  canEditTarget(targetId?: string) {
    return this.canEdit
      && (!targetId || !this.blockedTargets.has(targetId))
      && (!targetId || !this.groupBusy(`cue:${targetId}:text`))
      && (!targetId || !this.blockedGroups.has(`cue:${targetId}:text`));
  }

  private targetExists(action: SyncAction) {
    const state = this.bootstrap?.state;
    if (!state) return false;
    if (action.type === "createCue" || action.type === "createOrUpdateProfile" || action.type === "acknowledgeNotice") return true;
    if (action.type === "setSceneOwners") return action.scenes.every((item) => state.scenes.some((scene) => scene.id === item.sceneId));
    if (action.type === "assignCueNumbers") return action.cues.every((item) => state.cues.some((cue) => cue.id === item.cueId));
    if (action.type === "addNote") {
      if (action.discussion.cueId) return state.cues.some((cue) => cue.id === action.discussion.cueId);
      if (action.discussion.sceneId) return state.scenes.some((scene) => scene.id === action.discussion.sceneId);
      return true;
    }
    if (action.type === "addReply" || action.type === "setDiscussionResolved") return state.discussions.some((discussion) => discussion.id === action.discussionId);
    if (action.type === "restoreCue") return state.deletedCues.some((item) => item.id === action.cueId);
    if ("cueId" in action) return state.cues.some((cue) => cue.id === action.cueId);
    return true;
  }

  canDispatch(action: SyncAction) {
    const targetId = actionTargetId(action);
    if (!this.canEdit || (targetId && this.blockedTargets.has(targetId)) || !this.targetExists(action)) return false;
    return syncActionGroups(action).every((group) => !this.groupBusy(group) && !this.blockedGroups.has(group));
  }

  private setConnection(value: ConnectionState) {
    if (this.connection === value) return;
    this.connection = value;
    this.callbacks.onConnection(value);
  }

  private closeEditGate(value: ConnectionState) {
    if (this.freshnessTimer !== null) window.clearTimeout(this.freshnessTimer);
    this.freshnessTimer = null;
    this.lastFreshAt = 0;
    this.setConnection(value);
  }

  private groupBusy(group: string) {
    return this.inFlightGroups.has(group) || this.sequenceBarriers.has(group);
  }

  private markSequenceObserved(sequence: number) {
    let changed = false;
    for (const [group, through] of this.sequenceBarriers) if (through <= sequence) {
      this.sequenceBarriers.delete(group);
      changed = true;
    }
    if (changed) this.reportBusyGroups();
  }

  private rebuildRecoveryBlocks(items: SyncRecoveryItem[]) {
    this.blockedTargets.clear();
    this.blockedGroups.clear();
    for (const item of items) {
      const groups = recoveryItemGroups(item);
      if (groups.length) groups.forEach((group) => this.blockedGroups.add(group));
      else if (item.targetId) this.blockedTargets.add(item.targetId);
    }
  }

  private withLocalText(next: BootstrapPayload): BootstrapPayload {
    const cues = next.state.cues.map((cue) => {
      const session = this.textSessions.get(cue.id);
      const queued = this.textEditValues.get(cue.id);
      const hasLocalText = !!queued || !!session;
      if (!hasLocalText) return cue;
      return {
        ...cue,
        title: queued?.title ?? session?.document.getText("title").toString() ?? cue.title,
        description: queued?.description ?? session?.document.getText("description").toString() ?? cue.description,
        technicalNotes: queued?.technicalNotes ?? session?.document.getText("technicalNotes").toString() ?? cue.technicalNotes,
      };
    });
    return { ...next, state: { ...next.state, cues } };
  }

  private markFresh(startedAt: number) {
    this.lastFreshAt = startedAt;
    if (this.freshnessTimer !== null) window.clearTimeout(this.freshnessTimer);
    const remaining = Math.max(0, SYNC_FRESHNESS_MS - (performance.now() - startedAt));
    this.freshnessTimer = window.setTimeout(() => {
      this.freshnessTimer = null;
      if (this.connection === "online") {
        this.lastFreshAt = 0;
        this.setConnection("uncertain");
        this.scheduleRetry();
      }
    }, remaining);
  }

  private validActor(actorId: string) {
    return !!this.bootstrap?.state.profiles.some((profile) => profile.id === actorId);
  }

  private reportBusyGroups() {
    const groups = [...new Set([...this.inFlightGroups, ...this.sequenceBarriers.keys()])].sort();
    const signature = JSON.stringify(groups);
    if (signature === this.reportedBusyGroups) return;
    this.reportedBusyGroups = signature;
    this.callbacks.onBusyGroups(groups);
  }

  private setBusyGroups(records: PendingOperationRecord[]) {
    this.inFlightGroups.clear();
    for (const record of records) syncActionGroups(record.envelope.action).forEach((group) => this.inFlightGroups.add(group));
    this.reportBusyGroups();
  }

  private reopenAfterFresh(writeMode: BootstrapPayload["writeMode"], hintAtStart = this.remoteHintGeneration) {
    if (hintAtStart !== this.remoteHintGeneration) {
      this.setConnection("recovering");
      this.scheduleRetry();
      return false;
    }
    if (performance.now() - this.lastFreshAt > SYNC_FRESHNESS_MS) {
      this.closeEditGate("uncertain");
      this.scheduleRetry();
      return false;
    }
    this.setConnection(writeMode === "enabled" ? "online" : "maintenance");
    return true;
  }

  private async probe() {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), SYNC_PROBE_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.bootstrap) headers["if-none-match"] = `"sync-${this.bootstrap.epoch}-${this.bootstrap.sequence}"`;
      const response = await fetch("/api/sync/bootstrap", { cache: "no-store", headers, signal: controller.signal });
      const freshAt = performance.now();
      // Fetch resolves at headers. Keep the deadline through end-of-body so a
      // stalled response cannot leave startup or a refresh waiting indefinitely.
      // The original response stays readable by the handshake and poll paths.
      if (response.body) await response.clone().arrayBuffer();
      if (performance.now() - startedAt > SYNC_FRESHNESS_MS) throw new Error("The connection check arrived too late.");
      return { response, freshAt };
    } finally { window.clearTimeout(timer); }
  }

  private offlineCacheStatus(worker = navigator.serviceWorker?.controller) {
    return new Promise<{ version: string; complete: boolean } | null>((resolve) => {
      if (!worker) { resolve(null); return; }
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => resolve(null), 1_000);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timer);
        const value = event.data as { type?: string; version?: string; complete?: boolean };
        resolve(value.type === "SYNC_V2_CACHE_STATUS" && typeof value.version === "string" && typeof value.complete === "boolean" ? { version: value.version, complete: value.complete } : null);
      };
      worker.postMessage({ type: "SYNC_V2_CACHE_STATUS" }, [channel.port2]);
    });
  }

  private async waitForOfflineCacheVersion(timeoutMs = 15_000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const status = await this.offlineCacheStatus();
      if (status?.complete && status.version === OFFLINE_CACHE_VERSION) return status;
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(done, 200);
        function done() {
          window.clearTimeout(timer);
          navigator.serviceWorker.removeEventListener("controllerchange", done);
          resolve();
        }
        navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
      });
    }
    return null;
  }

  private async prepareOfflineCache() {
    if (!("serviceWorker" in navigator) || !this.store) return;
    const registration = await navigator.serviceWorker.register("/sync-v2-sw.js", { scope: "/", updateViaCache: "none" });
    await registration.update().catch(() => undefined);
    await navigator.serviceWorker.ready;
    const status = await this.waitForOfflineCacheVersion();
    if (!status) throw new Error("The offline cache is incomplete.");
    await this.store.markShellCache(status.version);
    this.callbacks.onOfflineCache(true);
  }

  async start(): Promise<"v2" | "legacy" | "cached" | "unavailable"> {
    this.setConnection("checking");
    if (!this.store) {
      try {
        this.store = await SyncClientStore.open();
        const imported = await this.store.importLegacyRecovery(localStorage);
        const recovery = await this.store.recoveryItems();
        this.callbacks.onRecovery(recovery);
        this.callbacks.onDrafts(await this.store.drafts());
        if (imported) this.callbacks.onError(syncNotice("N28", { count: recovery.length }));
      }
      catch { /* The server handshake decides whether this is legacy or a blocked v2 client. */ }
    }
    try {
      const { response, freshAt } = await this.probe();
      if (response.status === 304 && this.bootstrap && this.store) {
        this.markFresh(freshAt);
        this.setConnection("recovering");
        await this.sealRecoveredJournal();
        const recovered = await this.recoverPending();
        if (!this.reopenAfterFresh(this.bootstrap.writeMode)) {
          this.attachRuntime();
          return "v2";
        }
        if (recovered) this.resetRetry();
        else this.scheduleRetry();
        this.attachRuntime();
        return "v2";
      }
      if (response.status === 503) {
        const body = await response.clone().json().catch(() => ({})) as { code?: string };
        if (body.code === "migration_required") return "legacy";
      }
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("The sync handshake failed.");
      const bootstrap = await response.json() as BootstrapPayload;
      bootstrap.state = normalizeCueNumbers(bootstrap.state);
      if (bootstrap.protocol !== SYNC_PROTOCOL || bootstrap.workspaceId !== SYNC_WORKSPACE_ID) throw new Error("This dashboard uses an incompatible sync protocol.");
      this.bootstrap = bootstrap;
      this.markFresh(freshAt);
      this.callbacks.onBootstrap(bootstrap, "server");
      this.markSequenceObserved(bootstrap.sequence);
      if (!this.store) {
        this.setConnection("storage_blocked");
        this.callbacks.onError(syncNotice("N11"));
        return "v2";
      }
      await this.store.stageBootstrap(bootstrap, bootstrap.epoch, bootstrap.sequence, OFFLINE_CACHE_VERSION);
      if (bootstrap.writeMode !== "enabled") {
        this.setConnection("maintenance");
        return "v2";
      }
      this.setConnection("recovering");
      await this.sealRecoveredJournal();
      this.rebuildRecoveryBlocks(await this.store.recoveryItems());
      const recovered = await this.recoverPending();
      if (!this.reopenAfterFresh(bootstrap.writeMode)) {
        this.attachRuntime();
        return "v2";
      }
      if (recovered) this.resetRetry();
      else this.scheduleRetry();
      this.callbacks.onSave("saved");
      void this.prepareOfflineCache().catch(() => {
        this.callbacks.onOfflineCache(false);
      });
      this.attachRuntime();
      return "v2";
    } catch {
      const cached = await this.store?.cachedBootstrap();
      if (cached) {
        const bootstrap = cached.value as BootstrapPayload;
        bootstrap.state = normalizeCueNumbers(bootstrap.state);
        this.bootstrap = bootstrap;
        this.callbacks.onBootstrap(bootstrap, "cache");
        this.setConnection("offline");
        const cacheStatus = await this.offlineCacheStatus();
        this.callbacks.onOfflineCache(!!cacheStatus?.complete);
        this.callbacks.onSave("local");
        this.scheduleRetry();
        return "cached";
      }
      this.setConnection("offline");
      this.callbacks.onError(syncNotice("N27"));
      this.scheduleRetry();
      return "unavailable";
    }
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.visibleTextPollTimer !== null) window.clearInterval(this.visibleTextPollTimer);
    this.visibleTextCueId = null;
    this.visibleTextPollTimer = null;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.freshnessTimer !== null) window.clearTimeout(this.freshnessTimer);
    for (const session of this.textSessions.values()) if (session.timer !== null) window.clearTimeout(session.timer);
    this.channel?.close();
    window.removeEventListener("online", this.resume);
    window.removeEventListener("offline", this.lostConnection);
    window.removeEventListener("focus", this.resume);
    document.removeEventListener("visibilitychange", this.visibilityChange);
    window.removeEventListener("pagehide", this.pagehide);
    window.removeEventListener("pageshow", this.pageshow);
    this.store?.close();
  }

  setVisibleTextCue(cueId: string | null) {
    if (this.stopped) return;
    if (this.visibleTextCueId === cueId) return;
    this.visibleTextCueId = cueId;
    if (this.visibleTextPollTimer !== null) window.clearInterval(this.visibleTextPollTimer);
    this.visibleTextPollTimer = null;
    this.visibleTextRefresh = null;
    if (!cueId) return;
    void this.prepareText(cueId).then(() => this.refreshVisibleText());
    this.visibleTextPollTimer = window.setInterval(() => this.refreshVisibleText(), VISIBLE_TEXT_POLL_MS);
  }

  private refreshVisibleText() {
    const cueId = this.visibleTextCueId;
    if (!cueId || this.visibleTextRefresh || document.visibilityState !== "visible" || !transportAvailable()) return;
    const session = this.textSessions.get(cueId);
    if (!session || session.updates.length || session.pendingDependencies.length || this.textEditValues.has(cueId) || this.textEditQueues.has(cueId) || this.textSealQueues.has(cueId)) return;
    const refresh = this.refreshText(cueId).catch(() => undefined);
    this.visibleTextRefresh = refresh;
    void refresh.finally(() => {
      if (this.visibleTextRefresh === refresh) this.visibleTextRefresh = null;
    });
  }

  private startPolling() {
    if (this.pollTimer !== null) return;
    this.pollTimer = window.setInterval(() => { if (document.visibilityState === "visible") void this.refresh(); }, SYNC_POLL_MS);
  }

  private attachRuntime() {
    if (this.runtimeAttached) return;
    this.runtimeAttached = true;
    this.startPolling();
    window.addEventListener("online", this.resume);
    window.addEventListener("offline", this.lostConnection);
    window.addEventListener("focus", this.resume);
    document.addEventListener("visibilitychange", this.visibilityChange);
    window.addEventListener("pagehide", this.pagehide);
    window.addEventListener("pageshow", this.pageshow);
    if ("BroadcastChannel" in window) {
      this.channel = new BroadcastChannel("lighting-dashboard-sync-v2");
      this.channel.onmessage = (event) => {
        const sequence = Number(event.data?.sequence);
        if (Number.isSafeInteger(sequence) && sequence > (this.bootstrap?.sequence ?? 0)) {
          this.remoteHintGeneration += 1;
          this.closeEditGate("recovering");
        }
        void this.refresh();
      };
    }
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer !== null) return;
    const delay = retryDelay(this.retryAttempt++);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void (this.bootstrap ? this.refresh() : this.start());
    }, delay);
  }

  private resetRetry() {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAttempt = 0;
  }

  private async catchUpEvents(through: number) {
    if (!this.store || !this.bootstrap) throw new Error("The durable event store is unavailable.");
    let cursor = await this.store.eventCursor(this.bootstrap.epoch);
    if (cursor === null) throw new Error("The event cursor has not been initialized.");
    if (cursor > through) return;
    while (cursor < through) {
      const response = await fetch(`/api/sync/events?after=${cursor}&through=${through}`, { cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("The sync event page was unavailable.");
      const page = await response.json() as { protocol: number; epoch: string; through: number; nextCursor: number; complete: boolean; events: SyncEvent[] };
      if (page.protocol !== SYNC_PROTOCOL || page.epoch !== this.bootstrap.epoch || page.through !== through || !Array.isArray(page.events) || page.nextCursor < cursor || page.nextCursor > through) throw new Error("The sync event page was inconsistent.");
      if (!page.events.length && !page.complete) throw new Error("The sync event stream stopped before its target.");
      const applied = await this.store.applyEventPage(page.epoch, cursor, page.events, page.nextCursor);
      cursor = applied ? page.nextCursor : (await this.store.eventCursor(page.epoch)) ?? cursor;
      if (page.complete && cursor !== through) throw new Error("The sync event stream ended with a gap.");
    }
  }

  async refresh() {
    if (this.stopped || !this.bootstrap || document.visibilityState !== "visible") return;
    if (this.refreshPromise) {
      this.refreshAgain = true;
      return this.refreshPromise;
    }
    const current = Promise.resolve().then(() => this.performRefresh());
    this.refreshPromise = current;
    try {
      await current;
    } finally {
      this.refreshPromise = null;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }

  private async performRefresh() {
    if (this.stopped || !this.bootstrap || document.visibilityState !== "visible") return;
    try {
      const hintAtStart = this.remoteHintGeneration;
      const wasOnline = this.connection === "online";
      if (!wasOnline) this.setConnection("recovering");
      const { response, freshAt } = await this.probe();
      if (response.status === 304) {
        this.markSequenceObserved(this.bootstrap.sequence);
        this.markFresh(freshAt);
        const recovered = await this.recoverPending();
        if (!this.reopenAfterFresh(this.bootstrap.writeMode, hintAtStart)) return;
        if (recovered) this.resetRetry();
        else this.scheduleRetry();
        this.attachRuntime();
        return;
      }
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("Fresh sync data was unavailable.");
      const next = await response.json() as BootstrapPayload;
      next.state = normalizeCueNumbers(next.state);
      if (next.epoch !== this.bootstrap.epoch || next.protocol !== SYNC_PROTOCOL) {
        this.setConnection("upgrade_required");
        throw new Error("The workspace sync generation changed. Reload before editing.");
      }
      await this.catchUpEvents(next.sequence);
      this.bootstrap = next;
      this.markFresh(freshAt);
      await this.store?.stageBootstrap(next, next.epoch, next.sequence, OFFLINE_CACHE_VERSION);
      this.callbacks.onBootstrap(this.withLocalText(next), "server");
      this.markSequenceObserved(next.sequence);
      const knownCueIds = new Set([...next.state.cues.map((cue) => cue.id), ...next.state.deletedCues.map((item) => item.id)]);
      for (const [cueId, session] of this.textSessions) {
        if (knownCueIds.has(cueId)) continue;
        if (session.timer !== null) window.clearTimeout(session.timer);
        session.undoManager.destroy();
        session.document.destroy();
        this.textSessions.delete(cueId);
      }
      const textRevisions = new Map(next.textDocuments.map((document) => [document.cueId, document.revision]));
      await Promise.all([...this.textSessions.entries()].flatMap(([cueId, session]) => {
        const revision = textRevisions.get(cueId);
        return revision !== undefined && revision > session.revision ? [this.refreshText(cueId)] : [];
      }));
      const recovered = await this.recoverPending();
      if (!this.reopenAfterFresh(next.writeMode, hintAtStart)) return;
      if (recovered) this.resetRetry();
      else this.scheduleRetry();
      this.attachRuntime();
    } catch {
      if (this.connection !== "upgrade_required") {
        if (!transportAvailable()) this.closeEditGate("offline");
        else if (performance.now() - this.lastFreshAt > SYNC_FRESHNESS_MS) this.closeEditGate("uncertain");
      }
      this.scheduleRetry();
    }
  }

  private envelope(action: SyncAction, actorId: string, dependsOn: string[] = []): OperationEnvelope {
    if (!this.bootstrap) throw new Error("Sync has not started.");
    return { protocol: SYNC_PROTOCOL, workspaceId: SYNC_WORKSPACE_ID, epoch: this.bootstrap.epoch, operationId: crypto.randomUUID(), sessionId: this.sessionId, actorId, createdAt: new Date().toISOString(), dependsOn, action };
  }

  async dispatch(action: SyncAction, actorId: string, optimistic?: () => void) {
    if (!this.canDispatch(action) || !this.store || !this.validActor(actorId)) {
      this.callbacks.onError("Reconnect and finish syncing before editing.");
      return null;
    }
    const groups = syncActionGroups(action);
    groups.forEach((group) => this.inFlightGroups.add(group));
    this.reportBusyGroups();
    const envelope = this.envelope(action, actorId);
    const pending: PendingOperationRecord = { operationId: envelope.operationId, envelope, targetId: actionTargetId(action), createdAt: envelope.createdAt, attempts: 0 };
    try { await this.store.putPending(pending); }
    catch {
      groups.forEach((group) => this.inFlightGroups.delete(group));
      this.reportBusyGroups();
      this.setConnection("storage_blocked");
      this.callbacks.onError(syncNotice("N11"));
      return null;
    }
    optimistic?.();
    this.callbacks.onSave("sending");
    this.callbacks.onPending(await this.store.pendingCount());
    return this.send(pending);
  }

  async saveDraft(key: string, value: string, metadata?: Pick<SyncDraftRecord, "kind" | "targetId" | "actorId">) {
    if (!this.store || (metadata?.actorId && !this.validActor(metadata.actorId))) throw new Error("This draft could not be saved in browser storage.");
    await this.store.putDraft(key, value, metadata);
    this.callbacks.onDrafts(await this.store.drafts());
  }

  async protectDraft(key: string, value: string, metadata: Record<string, unknown>) {
    if (!this.canEdit || !this.store) throw new Error("Reconnect before saving this draft.");
    await this.store.protectDraft(key, value, metadata);
    this.callbacks.onRecovery(await this.store.recoveryItems());
  }

  async clearDraft(key: string) {
    await this.store?.deleteDraft(key);
    if (this.store) this.callbacks.onDrafts(await this.store.drafts());
  }

  async discardRecovery(id: string) {
    if (!this.store) return;
    await this.store.deleteRecovery(id);
    const remaining = await this.store.recoveryItems();
    this.rebuildRecoveryBlocks(remaining);
    this.callbacks.onRecovery(remaining);
    if (remaining.length === 0) this.callbacks.onSave("saved");
  }

  private async currentText(cueId: string) {
    if (!this.bootstrap) throw new Error("The workspace is not ready.");
    const response = await fetch(`/api/sync/text/${encodeURIComponent(cueId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("The current cue text could not be loaded.");
    const payload = await response.json() as TextPayload;
    if (payload.epoch !== this.bootstrap.epoch) throw new Error("The workspace changed. Refresh before reviewing this text.");
    const Y = await loadYjs();
    const document = new Y.Doc({ gc: true });
    for (const field of TEXT_FIELDS) document.getText(field);
    Y.applyUpdate(document, base64ToBytes(payload.encodedState), "server");
    return { payload, document, values: textValues(document) };
  }

  async textRecoveryPreview(cueId: string) {
    if (!this.store || !this.bootstrap) return null;
    const items = (await this.store.recoveryItems()).filter((item) => item.targetId === cueId && (item.kind === "text-history-missing" || item.envelope?.action.type === "applyTextUpdate"));
    if (!items.length) return null;
    const current = await this.currentText(cueId);
    const plan = textRecoveryPlan(items, current.values, this.bootstrap.epoch);
    return { revision: current.payload.revision, server: current.values, plan, itemIds: items.map((item) => item.id) };
  }

  async applyTextRecovery(cueId: string, expectedRevision: number, desired: TextValues, itemIds: string[], actorId: string) {
    if (!this.store || !this.bootstrap || !this.validActor(actorId) || !transportAvailable()) return "unavailable" as const;
    const currentIds = (await this.store.recoveryItems())
      .filter((item) => item.targetId === cueId && (item.kind === "text-history-missing" || item.envelope?.action.type === "applyTextUpdate"))
      .map((item) => item.id);
    if (currentIds.length !== itemIds.length || currentIds.some((id) => !itemIds.includes(id))) return "stale" as const;
    const current = await this.currentText(cueId);
    if (current.payload.revision !== expectedRevision) return "stale" as const;
    if (TEXT_FIELDS.every((field) => current.values[field] === desired[field])) {
      for (const id of itemIds) await this.store.deleteRecovery(id);
      const remaining = await this.store.recoveryItems();
      this.rebuildRecoveryBlocks(remaining);
      this.callbacks.onRecovery(remaining);
      this.textSessions.get(cueId)?.undoManager.destroy();
      this.textSessions.delete(cueId);
      const fresh = await this.loadText(cueId);
      if (fresh) for (const field of TEXT_FIELDS) this.callbacks.onText(cueId, field, fresh.document.getText(field).toString());
      return "applied" as const;
    }
    const Y = await loadYjs();
    const baseStateVector = Y.encodeStateVector(current.document);
    current.document.transact(() => {
      for (const field of TEXT_FIELDS) replaceText(current.document.getText(field), desired[field]);
    }, "text-recovery");
    const action: SyncAction = {
      type: "applyTextUpdate", cueId, baseDocumentRevision: current.payload.revision,
      expectedDocumentRevision: current.payload.revision,
      baseStateVector: bytesToBase64(baseStateVector),
      resultStateVector: bytesToBase64(Y.encodeStateVector(current.document)),
      update: bytesToBase64(Y.encodeStateAsUpdate(current.document, baseStateVector)),
    };
    const envelope = this.envelope(action, actorId);
    const pending: PendingOperationRecord = { operationId: envelope.operationId, envelope, targetId: cueId, createdAt: envelope.createdAt, attempts: 0, textFallback: { before: current.values, after: desired, epoch: this.bootstrap.epoch, actorId } };
    await this.store.putPending(pending);
    this.callbacks.onPending(await this.store.pendingCount());
    const result = await this.send(pending);
    if (result?.code === "repair_preview_stale") {
      await this.store.deleteRecovery(envelope.operationId);
      this.callbacks.onRecovery(await this.store.recoveryItems());
      return "stale" as const;
    }
    if (!result || !["applied", "adjusted", "unchanged"].includes(result.status)) return "unavailable" as const;
    for (const id of itemIds) await this.store.deleteRecovery(id);
    const remaining = await this.store.recoveryItems();
    this.rebuildRecoveryBlocks(remaining);
    this.callbacks.onRecovery(remaining);
    this.textSessions.get(cueId)?.undoManager.destroy();
    this.textSessions.delete(cueId);
    const fresh = await this.loadText(cueId);
    if (fresh) for (const field of TEXT_FIELDS) this.callbacks.onText(cueId, field, fresh.document.getText(field).toString());
    return "applied" as const;
  }

  private async protectAndRepairTextChain(pending: PendingOperationRecord, code: string, message: string) {
    if (!this.store || !this.bootstrap || !pending.targetId) return null;
    const cueId = pending.targetId;
    this.blockedTargets.add(cueId);
    await this.textEditQueues.get(cueId)?.catch(() => false);
    const result: OperationResult = { protocol: SYNC_PROTOCOL, workspaceId: SYNC_WORKSPACE_ID, epoch: this.bootstrap.epoch, operationId: pending.operationId, status: "invalid", sequence: this.bootstrap.sequence, code, message, outcome: { targetId: cueId } };
    const protectedChain = await this.store.protectTextChain(cueId, this.sessionId, result);
    if (!protectedChain) {
      this.scheduleRetry();
      return null;
    }
    const session = this.textSessions.get(cueId);
    if (session?.timer !== null && session?.timer !== undefined) window.clearTimeout(session.timer);
    session?.undoManager.destroy();
    this.textSessions.delete(cueId);
    for (const record of protectedChain.pending) syncActionGroups(record.envelope.action).forEach((group) => this.inFlightGroups.delete(group));
    this.reportBusyGroups();
    const recovery = await this.store.recoveryItems();
    this.rebuildRecoveryBlocks(recovery);
    this.callbacks.onRecovery(recovery);
    this.callbacks.onPending(await this.store.pendingCount());
    this.callbacks.onSave("needs_attention");
    try {
      const preview = await this.textRecoveryPreview(cueId);
      if (preview?.plan && preview.plan.conflicts.length === 0) {
        const actorId = [...recovery].filter((item) => item.targetId === cueId && item.textFallback)
          .sort((left, right) => (left.createdAt ?? left.envelope?.createdAt ?? "").localeCompare(right.createdAt ?? right.envelope?.createdAt ?? ""))
          .at(-1)?.textFallback?.actorId;
        if (actorId && this.validActor(actorId)) await this.applyTextRecovery(cueId, preview.revision, preview.plan.suggested, preview.itemIds, actorId);
      }
    } catch { /* The protected copy remains available for review. */ }
    return result;
  }

  private send(pending: PendingOperationRecord): Promise<OperationResult | null> {
    const existing = this.sendPromises.get(pending.operationId);
    if (existing) return existing;
    const running = this.performSend(pending).finally(() => {
      if (this.sendPromises.get(pending.operationId) === running) this.sendPromises.delete(pending.operationId);
    });
    this.sendPromises.set(pending.operationId, running);
    return running;
  }

  private async performSend(pending: PendingOperationRecord): Promise<OperationResult | null> {
    if (!this.store) return null;
    const claimed = await this.store.claimPending(pending.operationId, this.sessionId);
    if (!claimed) return null;
    pending = claimed;
    const requestBody = JSON.stringify({ operations: [pending.envelope] });
    if (new TextEncoder().encode(requestBody).byteLength > MAX_SYNC_REQUEST_BYTES) {
      return this.quarantinePending(pending, "request_too_large", "This saved change is too large to send safely.");
    }
    try {
      const response = await fetch("/api/sync/operations", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: requestBody });
      if (response.status === 426) {
        this.setConnection("upgrade_required");
        this.callbacks.onError(syncNotice("N24"));
      } else if (response.status === 401 || response.status === 403) {
        this.setConnection("maintenance");
        this.callbacks.onError(syncNotice("N30"));
      }
      if ([400, 413, 415, 422].includes(response.status) && !response.headers.get("content-type")?.includes("application/json")) {
        return this.quarantinePending(pending, response.status === 413 ? "request_too_large" : "request_rejected", response.status === 413 ? "This saved change is too large to send safely." : "The server rejected this saved change.");
      }
      if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("The server returned an unreadable operation result.");
      const body = await response.json() as { results?: OperationResult[] };
      const result = body.results?.[0];
      if (!result && [400, 413, 415, 422].includes(response.status)) return this.quarantinePending(pending, response.status === 413 ? "request_too_large" : "request_rejected", response.status === 413 ? "This saved change is too large to send safely." : "The server rejected this saved change.");
      if (!result && [401, 403, 426, 429, 503].includes(response.status)) {
        const message = response.status === 426 ? "A client update is required." : response.status === 401 || response.status === 403 ? "Server access is unavailable." : "The server is temporarily busy.";
        await this.store.updatePendingFailure(pending.operationId, message);
        this.callbacks.onSave("local");
        return { protocol: SYNC_PROTOCOL, workspaceId: SYNC_WORKSPACE_ID, epoch: this.bootstrap?.epoch ?? pending.envelope.epoch, operationId: pending.operationId, status: "retry_later", code: response.status === 426 ? "protocol_mismatch" : response.status === 401 || response.status === 403 ? "access_unavailable" : "server_busy", message };
      }
      if (!result) throw new Error("The server returned no operation result.");
      traceSync("operation-result", { pending: pendingDiagnostic(pending), result: resultDiagnostic(result) });
      if (result.status === "dependency_pending") {
        const dependency = typeof result.outcome?.dependency === "string" ? result.outcome.dependency : null;
        const localPending = await this.store.pending();
        const dependencyStillQueued = dependency ? localPending.some((record) => record.operationId === dependency) : false;
        if (dependency && !dependencyStillQueued) {
          if (pending.envelope.action.type === "applyTextUpdate" && pending.textFallback) {
            return this.protectAndRepairTextChain(pending, "dependency_missing", "An earlier text change is missing. The saved text has been kept for review.");
          }
          return this.quarantinePending(pending, "dependency_missing", "An earlier saved change is missing. This change has been kept for review.");
        }
        if (!dependency && result.code === "dependency_pending" && pending.attempts >= 2) {
          if (pending.envelope.action.type === "applyTextUpdate" && pending.textFallback) {
            return this.protectAndRepairTextChain(pending, "text_history_missing", "The server does not have earlier text history. The saved text has been kept for review.");
          }
          return this.quarantinePending(pending, "text_history_missing", "This text change needs earlier text history that is no longer available. The full change has been kept for review.");
        }
        await this.store.updatePendingFailure(pending.operationId, result.message ?? result.status);
        this.callbacks.onSave("local");
        this.scheduleRetry();
        return result;
      }
      if (result.status === "retry_later") {
        await this.store.updatePendingFailure(pending.operationId, result.message ?? result.status);
        this.callbacks.onSave("local");
        this.scheduleRetry();
        return result;
      }
      const terminalProblem = result.status === "invalid" || result.status === "not_applied";
      await this.store.settle(result, terminalProblem ? { id: pending.operationId, operationId: pending.operationId, targetId: pending.targetId, envelope: pending.envelope, result, textFallback: pending.textFallback, protectedAt: new Date().toISOString() } : undefined);
      const groups = syncActionGroups(pending.envelope.action);
      groups.forEach((group) => this.inFlightGroups.delete(group));
      if (!terminalProblem && result.sequence !== undefined && result.sequence > (this.bootstrap?.sequence ?? -1)) {
        groups.forEach((group) => this.sequenceBarriers.set(group, Math.max(this.sequenceBarriers.get(group) ?? 0, result.sequence!)));
      }
      this.reportBusyGroups();
      if (pending.envelope.action.type === "applyTextUpdate" && ["applied", "adjusted", "unchanged"].includes(result.status)) {
        const cueId = pending.envelope.action.cueId;
        const session = this.textSessions.get(cueId);
        if (session?.pendingDependencies.includes(pending.operationId)) {
          session.baseStateVector = base64ToBytes(pending.envelope.action.resultStateVector);
          session.pendingDependencies = session.pendingDependencies.filter((id) => id !== pending.operationId);
          void this.sealText(session, session.actorId).then(() => {
            if (!session.updates.length && !session.pendingDependencies.length) void this.refreshText(cueId);
          });
        }
      }
      const recoveryItems = await this.store.recoveryItems();
      this.rebuildRecoveryBlocks(recoveryItems);
      this.callbacks.onRecovery(recoveryItems);
      this.callbacks.onPending(await this.store.pendingCount());
      const cue = pending.targetId ? this.bootstrap?.state.cues.find((item) => item.id === pending.targetId) ?? this.bootstrap?.state.deletedCues.find((item) => item.id === pending.targetId)?.cue : undefined;
      const notice = operationNotice(result, cue?.title || formatCueNumber(cue?.number, "This cue"));
      if (notice && !terminalProblem) this.callbacks.onError(notice);
      else this.callbacks.onError(null);
      this.callbacks.onSave(result.status === "invalid" || result.status === "not_applied" ? "needs_attention" : "saved");
      if (pending.envelope.action.type === "createCue" && ["applied", "adjusted", "unchanged"].includes(result.status) && !this.textSessions.has(pending.envelope.action.cue.id) && !this.prepareTextPromises.has(pending.envelope.action.cue.id)) {
        const cueId = pending.envelope.action.cue.id;
        const prepared = this.loadText(cueId, true).finally(() => this.prepareTextPromises.delete(cueId));
        this.prepareTextPromises.set(cueId, prepared);
      }
      void this.refresh();
      this.channel?.postMessage({ sequence: result.sequence });
      return result;
    } catch (error) {
      traceSync("operation-error", { pending: pendingDiagnostic(pending), message: error instanceof Error ? error.message : "Request failed." });
      await this.store.updatePendingFailure(pending.operationId, error instanceof Error ? error.message : "Request failed.");
      if (!transportAvailable()) this.closeEditGate("offline");
      else if (performance.now() - this.lastFreshAt > SYNC_FRESHNESS_MS) this.closeEditGate("uncertain");
      this.callbacks.onSave("local");
      this.scheduleRetry();
      return null;
    }
  }

  private async quarantinePending(pending: PendingOperationRecord, code: string, message: string) {
    if (!this.store || !this.bootstrap) return null;
    const result: OperationResult = { protocol: SYNC_PROTOCOL, workspaceId: SYNC_WORKSPACE_ID, epoch: this.bootstrap.epoch, operationId: pending.operationId, status: "invalid", sequence: this.bootstrap.sequence, code, message, outcome: { targetId: pending.targetId } };
    await this.store.settle(result, { id: pending.operationId, operationId: pending.operationId, targetId: pending.targetId, envelope: pending.envelope, result, textFallback: pending.textFallback, protectedAt: new Date().toISOString() });
    syncActionGroups(pending.envelope.action).forEach((group) => this.inFlightGroups.delete(group));
    this.reportBusyGroups();
    const recoveryItems = await this.store.recoveryItems();
    this.rebuildRecoveryBlocks(recoveryItems);
    this.callbacks.onRecovery(recoveryItems);
    this.callbacks.onPending(await this.store.pendingCount());
    this.callbacks.onError(syncNotice("N23", { specificReason: message }));
    this.callbacks.onSave("needs_attention");
    return result;
  }

  private async recoverPending() {
    if (!this.store) return false;
    if (this.recovering) return await this.store.pendingCount() === 0;
    this.recovering = true;
    try {
      const pending = await this.store.pending();
      traceSync("pending-queue", pending.map(pendingDiagnostic));
      this.callbacks.onPending(pending.length);
      this.setBusyGroups(pending);
      const { ordered, blocked } = orderPendingOperations(pending);
      for (const record of blocked) {
        const claimed = await this.store.claimPending(record.operationId, this.sessionId);
        if (claimed) await this.quarantinePending(claimed, "dependency_cycle", "This saved change depends on a loop of unfinished changes. It has been kept for review.");
      }
      const blockedDependencies = new Set<string>();
      for (const record of ordered) {
        if (record.envelope.dependsOn.some((operationId) => blockedDependencies.has(operationId))) {
          blockedDependencies.add(record.operationId);
          continue;
        }
        const result = await this.send(record);
        if (!result) continue;
        if (result.status === "retry_later") break;
        // A missing dependency blocks only this operation. Keep walking so an
        // unrelated cue, note, or profile change cannot freeze behind it.
        if (result.status === "dependency_pending") blockedDependencies.add(record.operationId);
      }
      const remaining = await this.store.pending();
      this.callbacks.onPending(remaining.length);
      this.setBusyGroups(remaining);
      return remaining.length === 0;
    } finally { this.recovering = false; }
  }

  private async sealRecoveredJournal() {
    if (!this.store || !this.bootstrap) return;
    const Y = await loadYjs();
    const store = this.store;
    const records = await this.store.unsealedJournal();
    const protect = async (items: TextJournalRecord[]) => {
      await store.protectUnsealedJournal(items);
      const recovery = await store.recoveryItems();
      this.rebuildRecoveryBlocks(recovery);
      this.callbacks.onRecovery(recovery);
      this.callbacks.onSave("needs_attention");
    };
    const invalid = records.filter((record) => typeof record.cueId !== "string" || !record.cueId || typeof record.createdAt !== "string" || typeof record.actorId !== "string" || !record.actorId || !Number.isSafeInteger(record.baseDocumentRevision) || typeof record.update !== "string" || typeof record.baseStateVector !== "string" || typeof record.resultStateVector !== "string" || record.journalOrder !== undefined && (!Number.isSafeInteger(record.journalOrder) || record.journalOrder < 1));
    if (invalid.length) {
      await protect(invalid);
    }
    const invalidIds = new Set(invalid.map((record) => record.id));
    const validRecords = records.filter((record) => !invalidIds.has(record.id));
    const ownerKey = (cueId: string, owner: string) => JSON.stringify([cueId, owner]);
    const byOwner = new Map<string, TextJournalRecord[]>();
    for (const record of validRecords) {
      // Older entries without an owner cannot safely be combined with others.
      const key = ownerKey(record.cueId, record.ownerSessionId ?? `journal:${record.id}`);
      byOwner.set(key, [...byOwner.get(key) ?? [], record]);
    }
    const groups: Array<{ owner: string; records: TextJournalRecord[] }> = [];
    for (const recordsForOwner of byOwner.values()) {
      const ownerRecords = recordsForOwner.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || (left.journalOrder ?? 0) - (right.journalOrder ?? 0));
      const ambiguous = ownerRecords.some((record, index) => index > 0 && record.createdAt === ownerRecords[index - 1].createdAt && (record.journalOrder === undefined || ownerRecords[index - 1].journalOrder === undefined || record.journalOrder === ownerRecords[index - 1].journalOrder));
      if (ambiguous) {
        await protect(ownerRecords);
        continue;
      }
      let run: TextJournalRecord[] = [];
      for (const record of ownerRecords) {
        if (run.length && run[0].actorId !== record.actorId) {
          groups.push({ owner: run[0].ownerSessionId ?? `journal:${run[0].id}`, records: run });
          run = [];
        }
        run.push(record);
      }
      if (run.length) groups.push({ owner: run[0].ownerSessionId ?? `journal:${run[0].id}`, records: run });
    }
    groups.sort((left, right) => left.records[0].createdAt.localeCompare(right.records[0].createdAt));
    const lastByOwner = new Map<string, string>();
    for (const pending of await this.store.pending()) {
      if (pending.targetId && pending.envelope.action.type === "applyTextUpdate") lastByOwner.set(ownerKey(pending.targetId, pending.journalOwnerSessionId ?? pending.envelope.sessionId), pending.operationId);
    }
    for (const group of groups) {
      const first = group.records[0];
      const last = group.records.at(-1)!;
      const key = ownerKey(first.cueId, group.owner);
      const prior = lastByOwner.get(key);
      let update: string;
      try { update = bytesToBase64(Y.mergeUpdates(group.records.map((record) => base64ToBytes(record.update)))); }
      catch {
        await protect(group.records);
        continue;
      }
      const action: SyncAction = {
        type: "applyTextUpdate", cueId: first.cueId, baseDocumentRevision: first.baseDocumentRevision,
        baseStateVector: first.baseStateVector, resultStateVector: last.resultStateVector,
        update,
      };
      const envelope = this.envelope(action, first.actorId, prior ? [prior] : []);
      const textFallback = group.records.every((record) => record.textFallback) ? { ...first.textFallback!, after: last.textFallback!.after } : undefined;
      try {
        await this.store.sealJournal(group.records, { operationId: envelope.operationId, envelope, targetId: first.cueId, createdAt: envelope.createdAt, attempts: 0, textFallback, journalOwnerSessionId: first.ownerSessionId });
        lastByOwner.set(key, envelope.operationId);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("already sealed"))) throw error;
        // Another tab sealed this entry first. Its pending operation remains
        // available and will be included when the next entry is sealed.
        const matching = (await this.store.pending()).filter((pending) => pending.targetId === first.cueId && (pending.journalOwnerSessionId ?? pending.envelope.sessionId) === group.owner);
        if (matching.length) lastByOwner.set(key, matching.at(-1)!.operationId);
      }
    }
  }

  async prepareText(cueId: string) {
    const existing = this.textSessions.get(cueId);
    if (existing) return existing;
    const inFlight = this.prepareTextPromises.get(cueId);
    if (inFlight) return inFlight;
    const prepared = this.loadText(cueId).finally(() => this.prepareTextPromises.delete(cueId));
    this.prepareTextPromises.set(cueId, prepared);
    return prepared;
  }

  private async loadText(cueId: string, allowUnlisted = false): Promise<TextSession | null> {
    if (!this.bootstrap) return null;
    if (!allowUnlisted && !this.bootstrap.textDocuments.some((document) => document.cueId === cueId)) return null;
    const Y = await loadYjs();
    let payload: TextPayload | null = null;
    try {
      const response = await fetch(`/api/sync/text/${encodeURIComponent(cueId)}`, { cache: "no-store" });
      if (response.ok) {
        payload = await response.json() as TextPayload;
        await this.store?.putTextCache(this.bootstrap.epoch, cueId, payload);
      }
    } catch { /* Use the verified device cache for read-only viewing. */ }
    payload ??= await this.store?.cachedText(this.bootstrap.epoch, cueId) as TextPayload | undefined ?? null;
    if (!payload) return null;
    const document = new Y.Doc({ gc: true });
    const fields = ["title", "description", "technicalNotes"] as const;
    for (const field of fields) document.getText(field);
    Y.applyUpdate(document, base64ToBytes(payload.encodedState), "server");
    const undoManager = new Y.UndoManager(fields.map((field) => document.getText(field)), { trackedOrigins: new Set(["local"]), captureTimeout: 400 });
    const session: TextSession = { cueId, document, revision: payload.revision, hash: payload.hash ?? null, baseStateVector: base64ToBytes(payload.stateVector), updates: [], journal: [], startedAt: 0, timer: null, pendingDependencies: [], actorId: "guest", composing: false, undoManager };
    this.textSessions.set(cueId, session);
    return session;
  }

  editText(cueId: string, field: TextField, value: string, actorId: string): Promise<boolean> {
    // An input accepted while the gate was open stays admitted even if a
    // refresh closes the gate before its queued IndexedDB write runs.
    const admitted = this.canEditTarget(cueId);
    this.textEditValues.set(cueId, { ...this.textEditValues.get(cueId), [field]: value });
    const previous = this.textEditQueues.get(cueId) ?? Promise.resolve(true);
    const queued = previous.catch(() => false).then(() => this.applyTextEdit(cueId, field, value, actorId, admitted)).finally(() => {
      if (this.textEditQueues.get(cueId) === queued) {
        this.textEditQueues.delete(cueId);
        this.textEditValues.delete(cueId);
      }
    });
    this.textEditQueues.set(cueId, queued);
    return queued;
  }

  private async applyTextEdit(cueId: string, field: TextField, value: string, actorId: string, admitted: boolean) {
    const cueExists = this.bootstrap?.state.cues.some((cue) => cue.id === cueId) || this.textSessions.has(cueId) || this.prepareTextPromises.has(cueId);
    if (!admitted || !cueExists || !this.store || !this.validActor(actorId)) {
      this.callbacks.onError("Reconnect and finish syncing before editing.");
      return false;
    }
    const session = await this.prepareText(cueId);
    if (!session) {
      this.callbacks.onError("This cue text is not ready. Try again after syncing.");
      return false;
    }
    const Y = await loadYjs();
    session.actorId = actorId;
    const beforeText = textValues(session.document);
    const baseStateVectorBefore = Y.encodeStateVector(session.document);
    const updates: Uint8Array[] = [];
    const capture = (update: Uint8Array, origin: unknown) => { if (origin === "local") updates.push(update); };
    session.document.on("update", capture);
    session.document.transact(() => replaceText(session.document.getText(field), value), "local");
    session.document.off("update", capture);
    if (!updates.length) return true;
    const protectedLocally = await this.persistTextUpdates(session, baseStateVectorBefore, updates, actorId, beforeText);
    if (!protectedLocally) {
      // IndexedDB rejected the raw update, so keep the visible value and an
      // in-memory export item. N11 tells the user to keep the tab open because
      // this item is deliberately not described as durable device storage.
      this.callbacks.onText(cueId, field, this.textEditValues.get(cueId)?.[field] ?? value);
      const volatile: SyncRecoveryItem = {
        id: `volatile-text:${cueId}:${field}`,
        kind: "volatile-unsaved-text",
        targetId: cueId,
        raw: JSON.stringify({ cueId, field, value }),
        protectedAt: new Date().toISOString(),
      };
      const retained = await this.store.recoveryItems().catch(() => []);
      this.callbacks.onRecovery([...retained.filter((item) => item.id !== volatile.id), volatile]);
      return false;
    }
    this.callbacks.onText(cueId, field, this.textEditValues.get(cueId)?.[field] ?? value);
    return true;
  }

  private async persistTextUpdates(session: TextSession, baseStateVectorBefore: Uint8Array, updates: Uint8Array[], actorId: string, beforeText: TextValues) {
    if (!this.store) return false;
    const Y = await loadYjs();
    const update = Y.mergeUpdates(updates);
    const journal: TextJournalRecord = {
      id: crypto.randomUUID(), cueId: session.cueId, update: bytesToBase64(update), createdAt: new Date().toISOString(), journalOrder: ++this.journalOrder, operationId: null, actorId,
      baseDocumentRevision: session.revision, baseStateVector: bytesToBase64(baseStateVectorBefore), resultStateVector: bytesToBase64(Y.encodeStateVector(session.document)),
      textFallback: { before: beforeText, after: textValues(session.document), epoch: this.bootstrap!.epoch, actorId },
      ownerSessionId: this.sessionId,
    };
    try { await this.store.addJournal(journal); }
    catch {
      this.setConnection("storage_blocked");
      this.callbacks.onError(syncNotice("N11"));
      return false;
    }
    if (!session.updates.length && !session.pendingDependencies.length) {
      session.baseStateVector = baseStateVectorBefore;
      session.startedAt = Date.now();
    }
    session.updates.push(update);
    session.journal.push(journal);
    this.callbacks.onSave("local");
    if (!session.composing) {
      if (session.timer !== null) window.clearTimeout(session.timer);
      const delay = Math.max(0, Math.min(TEXT_SEND_IDLE_MS, TEXT_SEND_MAX_WAIT_MS - (Date.now() - session.startedAt)));
      session.timer = window.setTimeout(() => void this.sealText(session, actorId), delay);
    }
    return true;
  }

  async beginComposition(cueId: string) {
    const session = await this.prepareText(cueId);
    if (session) session.composing = true;
  }

  async endComposition(cueId: string, field: TextField, visibleValue: string, actorId: string) {
    const session = this.textSessions.get(cueId);
    if (!session) return;
    session.composing = false;
    const canonical = session.document.getText(field).toString();
    if (visibleValue !== canonical) {
      if (this.canEditTarget(cueId) && this.validActor(actorId)) await this.editText(cueId, field, visibleValue, actorId);
      else await this.preserveCompositionFragment(cueId, field, visibleValue, actorId);
    }
    if (session.updates.length) await this.sealText(session, actorId, this.canEdit);
  }

  private async preserveCompositionFragment(cueId: string, field: string, value: string, actorId: string) {
    const item: SyncRecoveryItem = { id: `composition:${cueId}:${field}:${crypto.randomUUID()}`, kind: "composition-fragment", targetId: cueId, raw: JSON.stringify({ cueId, field, value, actorId }), protectedAt: new Date().toISOString() };
    try {
      await this.store?.putRecovery(item);
      if (this.store) {
        const recoveryItems = await this.store.recoveryItems();
        this.rebuildRecoveryBlocks(recoveryItems);
        this.callbacks.onRecovery(recoveryItems);
      }
      this.callbacks.onError(syncNotice("N23", { specificReason: "the connection changed while text composition was finishing" }));
    } catch {
      this.closeEditGate("storage_blocked");
      this.callbacks.onRecovery([item]);
      this.callbacks.onError(syncNotice("N11"));
    }
  }

  async undoText(cueId: string, actorId: string, redo = false) {
    if (!this.canEditTarget(cueId) || !this.store || !this.validActor(actorId)) return false;
    const session = await this.prepareText(cueId);
    if (!session) return false;
    const Y = await loadYjs();
    session.actorId = actorId;
    const beforeText = textValues(session.document);
    const baseStateVectorBefore = Y.encodeStateVector(session.document);
    const updates: Uint8Array[] = [];
    const capture = (update: Uint8Array, origin: unknown) => { if (origin === session.undoManager) updates.push(update); };
    session.document.on("update", capture);
    if (redo) session.undoManager.redo(); else session.undoManager.undo();
    session.document.off("update", capture);
    if (!updates.length) return true;
    if (!await this.persistTextUpdates(session, baseStateVectorBefore, updates, actorId, beforeText)) return false;
    for (const field of ["title", "description", "technicalNotes"] as const) this.callbacks.onText(cueId, field, session.document.getText(field).toString());
    return true;
  }

  async flushText(cueId: string, actorId: string) {
    const session = this.textSessions.get(cueId);
    session?.undoManager.stopCapturing();
    if (!session || !this.store) return true;
    for (let pass = 0; pass < 8; pass += 1) {
      await this.textEditQueues.get(cueId)?.catch(() => false);
      await this.textSealQueues.get(cueId)?.catch(() => undefined);
      if (session.updates.length && !session.pendingDependencies.length) await this.sealText(session, actorId);
      await this.textSealQueues.get(cueId)?.catch(() => undefined);
      if (session.pendingDependencies.length) {
        const pending = await this.store.pending();
        for (const operationId of [...session.pendingDependencies]) {
          const record = pending.find((item) => item.operationId === operationId);
          const result = await (this.sendPromises.get(operationId) ?? (record ? this.send(record) : Promise.resolve(null)));
          if (!result || result.status === "dependency_pending" || result.status === "retry_later") return false;
        }
        continue;
      }
      if (!session.updates.length && !this.textEditQueues.has(cueId) && !this.textSealQueues.has(cueId)) return true;
    }
    return false;
  }

  async flushDesktop(actorId: string) {
    for (const cueId of this.textSessions.keys()) if (!await this.flushText(cueId, actorId)) return false;
    return await this.recoverPending();
  }

  stopTextCapture(cueId: string) {
    this.textSessions.get(cueId)?.undoManager.stopCapturing();
  }

  private sealText(session: TextSession, actorId: string, sendNow = true): Promise<void> {
    const previous = this.textSealQueues.get(session.cueId) ?? Promise.resolve();
    const admittedEdits = this.textEditQueues.get(session.cueId);
    const queued = previous.catch(() => undefined).then(() => admittedEdits?.catch(() => false)).then(() => this.performSealText(session, actorId, sendNow)).finally(() => {
      if (this.textSealQueues.get(session.cueId) === queued) this.textSealQueues.delete(session.cueId);
    });
    this.textSealQueues.set(session.cueId, queued);
    return queued;
  }

  private async performSealText(session: TextSession, actorId: string, sendNow = true) {
    if (!session.updates.length || !this.store || !this.bootstrap) return;
    const Y = await loadYjs();
    if (session.timer !== null) window.clearTimeout(session.timer);
    session.timer = null;
    // Later local edits may depend on structs from the operation in flight.
    // Keep them journaled, then seal them after the server acknowledges that
    // earlier state.
    if (session.pendingDependencies.length) return;
    const update = Y.encodeStateAsUpdate(session.document, session.baseStateVector);
    const action: SyncAction = { type: "applyTextUpdate", cueId: session.cueId, baseDocumentRevision: session.revision, baseStateVector: bytesToBase64(session.baseStateVector), resultStateVector: bytesToBase64(Y.encodeStateVector(session.document)), update: bytesToBase64(update) };
    const envelope = this.envelope(action, actorId, session.pendingDependencies);
    const covered = session.journal;
    const firstFallback = covered[0]?.textFallback;
    const lastFallback = covered.at(-1)?.textFallback;
    const textFallback = firstFallback && lastFallback ? { ...firstFallback, after: lastFallback.after } : undefined;
    const pending: PendingOperationRecord = { operationId: envelope.operationId, envelope, targetId: session.cueId, createdAt: envelope.createdAt, attempts: 0, textFallback };
    session.updates = [];
    session.journal = [];
    session.startedAt = 0;
    session.pendingDependencies = [envelope.operationId];
    try { await this.store.sealJournal(covered, pending); }
    catch (error) {
      if (error instanceof Error && error.message.includes("already sealed")) {
        session.pendingDependencies = [];
        void this.recoverPending();
        return;
      }
      session.updates = [update, ...session.updates];
      session.journal = [...covered, ...session.journal];
      this.setConnection("storage_blocked");
      this.callbacks.onError(syncNotice("N11"));
      return;
    }
    this.callbacks.onPending(await this.store.pendingCount());
    if (!sendNow || !this.canEdit || !transportAvailable() || document.visibilityState !== "visible") {
      this.callbacks.onSave("local");
      return;
    }
    this.callbacks.onSave("sending");
    await this.send(pending);
  }

  private async refreshText(cueId: string) {
    const session = this.textSessions.get(cueId);
    if (!session || session.updates.length || session.pendingDependencies.length || this.textEditValues.has(cueId) || this.textEditQueues.has(cueId) || this.textSealQueues.has(cueId)) return;
    const Y = await loadYjs();
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.bootstrap && session.hash) headers["if-none-match"] = `"text-${this.bootstrap.epoch}-${cueId}-${session.revision}-${session.hash}"`;
    const response = await fetch(`/api/sync/text/${encodeURIComponent(cueId)}`, { cache: "no-store", headers });
    if (response.status === 304) return;
    if (!response.ok) return;
    const payload = await response.json() as TextPayload;
    if (this.textSessions.get(cueId) !== session || session.updates.length || session.pendingDependencies.length || this.textEditValues.has(cueId) || this.textEditQueues.has(cueId) || this.textSealQueues.has(cueId)) return;
    if (payload.revision < session.revision) return;
    if (payload.revision === session.revision) {
      session.hash = payload.hash ?? session.hash;
      void this.store?.putTextCache(this.bootstrap!.epoch, cueId, payload).catch(() => undefined);
      return;
    }
    const focused = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
    const focusedField = focused?.dataset.syncTextField as "title" | "description" | "technicalNotes" | undefined;
    const trackSelection = focused?.dataset.syncCueId === cueId && focusedField && focused.selectionStart !== null && focused.selectionEnd !== null;
    const relativeStart = trackSelection ? Y.createRelativePositionFromTypeIndex(session.document.getText(focusedField), focused.selectionStart!) : null;
    const relativeEnd = trackSelection ? Y.createRelativePositionFromTypeIndex(session.document.getText(focusedField), focused.selectionEnd!) : null;
    const previousFocusedValue = trackSelection ? session.document.getText(focusedField).toString() : null;
    Y.applyUpdate(session.document, base64ToBytes(payload.encodedState), "remote");
    session.revision = payload.revision;
    session.hash = payload.hash ?? null;
    session.baseStateVector = Y.encodeStateVector(session.document);
    void this.store?.putTextCache(this.bootstrap!.epoch, cueId, payload).catch(() => undefined);
    const queued = this.textEditValues.get(cueId);
    for (const field of ["title", "description", "technicalNotes"] as const) this.callbacks.onText(cueId, field, queued?.[field] ?? session.document.getText(field).toString());
    const focusedTextChanged = trackSelection && previousFocusedValue !== session.document.getText(focusedField).toString();
    if (focusedTextChanged) this.callbacks.onRemoteText(cueId, focusedField);
    // Acknowledging our own edit advances the revision without changing text.
    // Restoring that old caret on the next frame can undo a subsequent Select
    // All, making a replacement append instead. Only actual text changes need
    // relative-position restoration.
    if (focusedTextChanged && focused && relativeStart && relativeEnd) window.requestAnimationFrame(() => {
      const start = Y.createAbsolutePositionFromRelativePosition(relativeStart, session.document);
      const end = Y.createAbsolutePositionFromRelativePosition(relativeEnd, session.document);
      if (document.activeElement === focused && start?.type === session.document.getText(focusedField!) && end?.type === start.type) focused.setSelectionRange(start.index, end.index);
    });
  }
}
