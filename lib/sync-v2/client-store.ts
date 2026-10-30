import type { OperationEnvelope, OperationResult, SyncEvent } from "./protocol.ts";

const DATABASE_NAME = "lighting-dashboard-sync-v2";
const DATABASE_VERSION = 3;

export type PendingOperationRecord = {
  operationId: string;
  envelope: OperationEnvelope;
  targetId?: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
  leaseOwner?: string;
  leaseUntil?: number;
  journalOwnerSessionId?: string;
  textFallback?: TextFallback;
};

export type TextValues = { title: string; description: string; technicalNotes: string };
export type TextFallback = { before: TextValues; after: TextValues; epoch: string; actorId: string };

export type TextJournalRecord = {
  id: string;
  cueId: string;
  update: string;
  createdAt: string;
  journalOrder?: number;
  operationId: string | null;
  actorId: string;
  baseDocumentRevision: number;
  baseStateVector: string;
  resultStateVector: string;
  textFallback?: TextFallback;
  ownerSessionId?: string;
};

export type CachedBootstrap = {
  key: string;
  generation: string;
  complete: boolean;
  value: unknown;
  savedAt: string;
  shellVersion?: string;
  requiredShellVersion?: string;
};

export type SyncRecoveryItem = { id: string; operationId?: string; targetId?: string; kind?: string; sourceKey?: string; raw?: string; envelope?: OperationEnvelope; result?: OperationResult; createdAt?: string; protectedAt?: string; textFallback?: TextFallback };
export type SyncDraftRecord = { key: string; value: string; savedAt: string; kind?: "note" | "reply" | "profile" | "new-cue" | "rejected-paste"; targetId?: string; actorId?: string };

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Browser storage request failed."));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Browser storage transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Browser storage transaction was cancelled."));
  });
}

export class SyncClientStore {
  private constructor(private readonly database: IDBDatabase) {}

  static open() {
    return new Promise<SyncClientStore>((resolve, reject) => {
      const request = indexedDB.open(`${DATABASE_NAME}${globalThis.window?.desktopShowId ? `:${window.desktopShowId}` : ""}`, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta", { keyPath: "key" });
        if (!database.objectStoreNames.contains("pending")) database.createObjectStore("pending", { keyPath: "operationId" });
        if (!database.objectStoreNames.contains("receipts")) database.createObjectStore("receipts", { keyPath: "operationId" });
        if (!database.objectStoreNames.contains("journal")) {
          const journal = database.createObjectStore("journal", { keyPath: "id" });
          journal.createIndex("cue", "cueId", { unique: false });
          journal.createIndex("operation", "operationId", { unique: false });
        }
        if (!database.objectStoreNames.contains("drafts")) database.createObjectStore("drafts", { keyPath: "key" });
        if (!database.objectStoreNames.contains("cache")) database.createObjectStore("cache", { keyPath: "key" });
        if (!database.objectStoreNames.contains("text-cache")) database.createObjectStore("text-cache", { keyPath: "key" });
        if (!database.objectStoreNames.contains("recovery")) database.createObjectStore("recovery", { keyPath: "id" });
        if (!database.objectStoreNames.contains("events")) database.createObjectStore("events", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(new SyncClientStore(request.result));
      request.onerror = () => reject(request.error ?? new Error("Browser storage could not be opened."));
      request.onblocked = () => reject(new Error("Close older dashboard tabs so browser storage can be upgraded."));
    });
  }

  async pending() {
    const transaction = this.database.transaction("pending", "readonly");
    const values = await requestValue(transaction.objectStore("pending").getAll() as IDBRequest<PendingOperationRecord[]>);
    await transactionDone(transaction);
    return values.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async putPending(record: PendingOperationRecord) {
    const transaction = this.database.transaction("pending", "readwrite");
    transaction.objectStore("pending").put(record);
    await transactionDone(transaction);
  }

  async pendingCount() {
    const transaction = this.database.transaction("pending", "readonly");
    const count = await requestValue(transaction.objectStore("pending").count());
    await transactionDone(transaction);
    return count;
  }

  async updatePendingFailure(operationId: string, message: string) {
    const transaction = this.database.transaction("pending", "readwrite");
    const store = transaction.objectStore("pending");
    const current = await requestValue(store.get(operationId) as IDBRequest<PendingOperationRecord | undefined>);
    if (current) store.put({ ...current, attempts: current.attempts + 1, lastError: message, leaseOwner: undefined, leaseUntil: undefined });
    await transactionDone(transaction);
  }

  async claimPending(operationId: string, owner: string, now = Date.now(), leaseMs = 15_000) {
    const transaction = this.database.transaction("pending", "readwrite");
    const store = transaction.objectStore("pending");
    const current = await requestValue(store.get(operationId) as IDBRequest<PendingOperationRecord | undefined>);
    if (!current || current.leaseOwner && current.leaseOwner !== owner && (current.leaseUntil ?? 0) > now) {
      await transactionDone(transaction);
      return null;
    }
    const claimed = { ...current, leaseOwner: owner, leaseUntil: now + leaseMs } satisfies PendingOperationRecord;
    store.put(claimed);
    await transactionDone(transaction);
    return claimed;
  }

  async settle(result: OperationResult, recovery?: { id: string } & Record<string, unknown>) {
    const transaction = this.database.transaction(["pending", "receipts", "recovery"], "readwrite");
    transaction.objectStore("receipts").put(result);
    if (recovery) transaction.objectStore("recovery").put(recovery);
    transaction.objectStore("pending").delete(result.operationId);
    await transactionDone(transaction);
    try {
      const cleanup = this.database.transaction("journal", "readwrite");
      const store = cleanup.objectStore("journal");
      const records = await requestValue(store.index("operation").getAll(IDBKeyRange.only(result.operationId)) as IDBRequest<TextJournalRecord[]>);
      for (const record of records) store.delete(record.id);
      await transactionDone(cleanup);
    } catch {
      // A sealed journal entry is inert. The receipt and pending deletion above
      // must stay committed so a cleanup fault cannot replay a saved operation.
    }
  }

  async addJournal(record: TextJournalRecord) {
    const transaction = this.database.transaction("journal", "readwrite");
    transaction.objectStore("journal").add(record);
    await transactionDone(transaction);
  }

  async sealJournal(records: TextJournalRecord[], pending: PendingOperationRecord) {
    const transaction = this.database.transaction(["journal", "pending"], "readwrite");
    const journal = transaction.objectStore("journal");
    for (const record of records) {
      const current = await requestValue(journal.get(record.id) as IDBRequest<TextJournalRecord | undefined>);
      if (!current || current.operationId) {
        transaction.abort();
        throw new Error("This text edit was already sealed by another tab.");
      }
    }
    transaction.objectStore("pending").add(pending);
    for (const record of records) journal.put({ ...record, operationId: pending.operationId });
    await transactionDone(transaction);
  }

  async protectTextChain(cueId: string, owner: string, result: OperationResult) {
    const transaction = this.database.transaction(["pending", "journal", "receipts", "recovery"], "readwrite");
    const pendingStore = transaction.objectStore("pending");
    const journalStore = transaction.objectStore("journal");
    const pending = (await requestValue(pendingStore.getAll() as IDBRequest<PendingOperationRecord[]>))
      .filter((record) => record.targetId === cueId && record.envelope.action.type === "applyTextUpdate")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const cueJournal = await requestValue(journalStore.index("cue").getAll(IDBKeyRange.only(cueId)) as IDBRequest<TextJournalRecord[]>);
    const unsealed = cueJournal.filter((record) => !record.operationId).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const now = Date.now();
    if (pending.some((record) => record.leaseOwner && record.leaseOwner !== owner && (record.leaseUntil ?? 0) > now)
      || unsealed.some((record) => record.ownerSessionId && record.ownerSessionId !== owner)) {
      await transactionDone(transaction);
      return null;
    }
    const recovery = transaction.objectStore("recovery");
    const protectedAt = new Date().toISOString();
    for (const record of pending) {
      recovery.put({ id: record.operationId, operationId: record.operationId, kind: "text-history-missing", targetId: cueId, envelope: record.envelope, textFallback: record.textFallback, result: { ...result, operationId: record.operationId }, createdAt: record.createdAt, protectedAt } satisfies SyncRecoveryItem);
      transaction.objectStore("receipts").put({ ...result, operationId: record.operationId });
      pendingStore.delete(record.operationId);
    }
    for (const record of unsealed) {
      recovery.put({ id: `journal:${record.id}`, kind: "text-history-missing", targetId: cueId, raw: JSON.stringify(record), textFallback: record.textFallback, result, createdAt: record.createdAt, protectedAt } satisfies SyncRecoveryItem);
      journalStore.delete(record.id);
    }
    const protectedIds = new Set(pending.map((record) => record.operationId));
    for (const record of cueJournal) if (record.operationId && protectedIds.has(record.operationId)) journalStore.delete(record.id);
    await transactionDone(transaction);
    return { pending, unsealed };
  }

  async unsealedJournal() {
    const transaction = this.database.transaction("journal", "readonly");
    const records = await requestValue(transaction.objectStore("journal").getAll() as IDBRequest<TextJournalRecord[]>);
    await transactionDone(transaction);
    return records.filter((record) => !record.operationId).sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
  }

  async protectUnsealedJournal(records: TextJournalRecord[]) {
    const transaction = this.database.transaction(["journal", "recovery"], "readwrite");
    const journal = transaction.objectStore("journal");
    const recovery = transaction.objectStore("recovery");
    for (const record of records) {
      const current = await requestValue(journal.get(record.id) as IDBRequest<TextJournalRecord | undefined>);
      if (!current || current.operationId) continue;
      recovery.put({ id: `journal:${current.id}`, kind: "text-history-missing", targetId: current.cueId, raw: JSON.stringify(current), textFallback: current.textFallback, createdAt: current.createdAt, protectedAt: new Date().toISOString() } satisfies SyncRecoveryItem);
      journal.delete(current.id);
    }
    await transactionDone(transaction);
  }

  async drafts() {
    const transaction = this.database.transaction("drafts", "readonly");
    const values = await requestValue(transaction.objectStore("drafts").getAll() as IDBRequest<SyncDraftRecord[]>);
    await transactionDone(transaction);
    return values.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }

  async putDraft(key: string, value: string, metadata: Pick<SyncDraftRecord, "kind" | "targetId" | "actorId"> = {}) {
    const transaction = this.database.transaction("drafts", "readwrite");
    transaction.objectStore("drafts").put({ key, value, savedAt: new Date().toISOString(), ...metadata } satisfies SyncDraftRecord);
    await transactionDone(transaction);
  }

  async protectDraft(key: string, value: string, metadata: Record<string, unknown>) {
    const transaction = this.database.transaction(["drafts", "recovery"], "readwrite");
    const savedAt = new Date().toISOString();
    transaction.objectStore("drafts").put({ key, value, savedAt });
    transaction.objectStore("recovery").put({ id: `draft:${key}`, kind: "protected-draft", raw: value, protectedAt: savedAt, ...metadata });
    await transactionDone(transaction);
  }

  async deleteDraft(key: string) {
    const transaction = this.database.transaction("drafts", "readwrite");
    transaction.objectStore("drafts").delete(key);
    await transactionDone(transaction);
  }

  async stageBootstrap(value: unknown, epoch: string, sequence: number, requiredShellVersion: string) {
    const generation = `${epoch}:${sequence}`;
    const transaction = this.database.transaction(["cache", "meta"], "readwrite");
    const meta = transaction.objectStore("meta");
    const shell = await requestValue(meta.get("offline-shell-version") as IDBRequest<{ key: string; value: string } | undefined>);
    const active = await requestValue(meta.get("active-cache-generation") as IDBRequest<{ key: string; value: string } | undefined>);
    const complete = shell?.value === requiredShellVersion;
    const cache = transaction.objectStore("cache");
    const keys = await requestValue(cache.getAllKeys());
    // Retain the last complete generation until the new shell is ready, rather
    // than accumulating a complete workspace snapshot for every edit forever.
    for (const key of keys) if (key !== generation && (complete || key !== active?.value)) cache.delete(key);
    cache.put({ key: generation, generation, complete, value, savedAt: new Date().toISOString(), shellVersion: complete ? requiredShellVersion : undefined, requiredShellVersion } satisfies CachedBootstrap);
    meta.put({ key: "staged-cache-generation", value: generation });
    if (complete) meta.put({ key: "active-cache-generation", value: generation });
    // A full server snapshot is authoritative through this sequence. Resetting
    // the cursor here prevents old events from being replayed over a newer view
    // after a reload or a crash between event pages.
    meta.put({ key: `event-cursor:${epoch}`, value: sequence });
    await transactionDone(transaction);
  }

  async markShellCache(version: string) {
    const transaction = this.database.transaction(["cache", "meta"], "readwrite");
    const meta = transaction.objectStore("meta");
    const staged = await requestValue(meta.get("staged-cache-generation") as IDBRequest<{ key: string; value: string } | undefined>);
    meta.put({ key: "offline-shell-version", value: version });
    if (staged) {
      const cache = transaction.objectStore("cache");
      const current = await requestValue(cache.get(staged.value) as IDBRequest<CachedBootstrap | undefined>);
      if (current?.requiredShellVersion === version) {
        cache.put({ ...current, complete: true, shellVersion: version });
        meta.put({ key: "active-cache-generation", value: staged.value });
      }
    }
    await transactionDone(transaction);
  }

  async eventCursor(epoch: string) {
    const transaction = this.database.transaction("meta", "readonly");
    const record = await requestValue(transaction.objectStore("meta").get(`event-cursor:${epoch}`) as IDBRequest<{ key: string; value: number } | undefined>);
    await transactionDone(transaction);
    return Number.isSafeInteger(record?.value) ? record!.value : null;
  }

  async applyEventPage(epoch: string, expectedCursor: number, events: SyncEvent[], nextCursor: number) {
    let cursor = expectedCursor;
    for (const event of events) {
      if (event.protocol !== 2 || event.epoch !== epoch || event.sequence !== cursor + 1) throw new Error("The sync event stream has a gap.");
      cursor = event.sequence;
    }
    if (nextCursor !== cursor) throw new Error("The sync event cursor does not match its page.");
    const transaction = this.database.transaction(["events", "meta"], "readwrite");
    const meta = transaction.objectStore("meta");
    const current = await requestValue(meta.get(`event-cursor:${epoch}`) as IDBRequest<{ key: string; value: number } | undefined>);
    if ((current?.value ?? expectedCursor) !== expectedCursor) {
      await transactionDone(transaction);
      return false;
    }
    const store = transaction.objectStore("events");
    for (const event of events) store.put({ key: `${epoch}:${event.sequence}`, ...event });
    meta.put({ key: `event-cursor:${epoch}`, value: nextCursor });
    await transactionDone(transaction);
    return true;
  }

  async cachedBootstrap() {
    const transaction = this.database.transaction(["cache", "meta"], "readonly");
    const meta = transaction.objectStore("meta");
    const active = await requestValue(meta.get("active-cache-generation") as IDBRequest<{ key: string; value: string } | undefined>);
    const shell = await requestValue(meta.get("offline-shell-version") as IDBRequest<{ key: string; value: string } | undefined>);
    const cached = active ? await requestValue(transaction.objectStore("cache").get(active.value) as IDBRequest<CachedBootstrap | undefined>) : undefined;
    await transactionDone(transaction);
    return cached?.complete && active?.value === cached.generation && cached.requiredShellVersion === shell?.value && cached.shellVersion === shell?.value ? cached : null;
  }

  async putTextCache(epoch: string, cueId: string, value: unknown) {
    const transaction = this.database.transaction("text-cache", "readwrite");
    transaction.objectStore("text-cache").put({ key: `${epoch}:${cueId}`, epoch, cueId, value, savedAt: new Date().toISOString() });
    await transactionDone(transaction);
  }

  async cachedText(epoch: string, cueId: string) {
    const transaction = this.database.transaction("text-cache", "readonly");
    const cached = await requestValue(transaction.objectStore("text-cache").get(`${epoch}:${cueId}`) as IDBRequest<{ value: unknown } | undefined>);
    await transactionDone(transaction);
    return cached?.value;
  }

  async putRecovery(value: { id: string } & Record<string, unknown>) {
    const transaction = this.database.transaction("recovery", "readwrite");
    transaction.objectStore("recovery").put(value);
    await transactionDone(transaction);
  }

  async importLegacyRecovery(storage: Storage) {
    const sourceKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith("lt-pending-workspace-mutation") && key !== "lt-pending-workspace-mutation:diagnostics") sourceKeys.push(key);
    }
    if (!sourceKeys.length) return 0;
    const transaction = this.database.transaction("recovery", "readwrite");
    const recovery = transaction.objectStore("recovery");
    const existing = new Set((await requestValue(recovery.getAllKeys())).map(String));
    let imported = 0;
    for (const sourceKey of sourceKeys) {
      const raw = storage.getItem(sourceKey);
      const id = `legacy:${sourceKey}`;
      if (raw === null || existing.has(id)) continue;
      recovery.put({ id, kind: "legacy-workspace-recovery", sourceKey, raw, protectedAt: new Date().toISOString() } satisfies SyncRecoveryItem);
      imported += 1;
    }
    await transactionDone(transaction);
    return imported;
  }

  async recoveryItems() {
    const transaction = this.database.transaction("recovery", "readonly");
    const items = await requestValue(transaction.objectStore("recovery").getAll() as IDBRequest<SyncRecoveryItem[]>);
    await transactionDone(transaction);
    return items;
  }

  async deleteRecovery(id: string) {
    const transaction = this.database.transaction("recovery", "readwrite");
    transaction.objectStore("recovery").delete(id);
    await transactionDone(transaction);
  }

  close() {
    this.database.close();
  }
}
