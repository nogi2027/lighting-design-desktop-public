import { isCueAssignmentValid, readCueNumber } from "./cue-numbering.ts";
import type { Cue, Discussion, DeletedCue, WorkspaceConflictRecord, WorkspaceState } from "./types";

/** A value change addressed by collection name, record id, and field names. */
export type WorkspaceChange = {
  op: "set" | "delete" | "reorder";
  path: string[];
  value?: unknown;
};

/** The compact, revision-checked mutation sent by current clients. */
export type WorkspacePatchMutation = {
  baseRevision: number;
  changes: WorkspaceChange[];
  mutationId: string;
};

/** A compact durable copy used only by the browser recovery queue. */
export type WorkspaceRecoveryChange = WorkspaceChange & {
  baseExists: boolean;
  baseValue?: unknown;
};

export type WorkspaceRecoveryMutation = {
  version: 2;
  baseRevision: number;
  changes: WorkspaceRecoveryChange[];
  mutationId: string;
};

/** The full-snapshot mutation kept for already-open and older clients. */
export type WorkspaceSnapshotMutation = {
  baseRevision: number;
  base: WorkspaceState;
  next: WorkspaceState;
  mutationId: string;
};

/** Legacy name retained for callers that still use full snapshots. */
export type WorkspaceMutation = WorkspaceSnapshotMutation;

export type WorkspaceConflict = {
  /** Human-readable path, for example `cues[cue-1].title`. */
  path: string;
  /** The same path in the format consumed by applyWorkspaceChanges. */
  pathSegments: string[];
  base: unknown;
  remote: unknown;
  incoming: unknown;
  kind?: "merge" | "number-repair";
  repaired?: unknown;
  occurrenceId?: string;
};

export type WorkspaceSnapshot = {
  state: WorkspaceState;
  revision: number;
  updatedAt: string;
  /** Required only after an intentional Sync v2 to v1 rollback. */
  legacyGeneration?: string;
  recentMutationIds?: string[];
  /** Conflicts found while accepting this mutation. */
  conflicts?: WorkspaceConflict[];
  recoveryFailures?: Array<{ mutationId: string; status?: number; message: string; retryable?: boolean }>;
};

function equal(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isKeyedArray(value: unknown[]): value is Array<Record<string, unknown> & { id: string }> {
  return value.every((item) => isRecord(item) && typeof item.id === "string");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function conflictPath(path: string[]) {
  let label = "";
  path.forEach((segment, index) => {
    if (index === 0) label = segment;
    else if (index % 2 === 1) label += `[${segment}]`;
    else label += `.${segment}`;
  });
  return label;
}

function pushConflict(
  conflicts: WorkspaceConflict[],
  path: string[],
  base: unknown,
  remote: unknown,
  incoming: unknown,
  kind: "merge" | "number-repair" = "merge",
  repaired?: unknown,
  occurrenceId?: string,
) {
  conflicts.push({
    path: conflictPath(path),
    pathSegments: [...path],
    base: clone(base),
    remote: clone(remote),
    incoming: clone(incoming),
    ...(kind === "merge" ? {} : { kind }),
    ...(repaired === undefined ? {} : { repaired: clone(repaired) }),
    ...(occurrenceId ? { occurrenceId } : {}),
  });
}

function mergeValue(
  base: unknown,
  incoming: unknown,
  remote: unknown,
  path: string[],
  conflicts: WorkspaceConflict[],
): unknown {
  if (equal(incoming, base)) return remote;
  if (equal(remote, base) || equal(remote, incoming)) return incoming;

  if (Array.isArray(base) && Array.isArray(incoming) && Array.isArray(remote) && isKeyedArray(base) && isKeyedArray(incoming) && isKeyedArray(remote)) {
    const baseById = new Map(base.map((item) => [item.id, item]));
    const incomingById = new Map(incoming.map((item) => [item.id, item]));
    const remoteById = new Map(remote.map((item) => [item.id, item]));
    const mergedById = new Map(remoteById);

    baseById.forEach((baseItem, id) => {
      const incomingItem = incomingById.get(id);
      const remoteItem = remoteById.get(id);
      if (!incomingItem) {
        if (remoteItem && !equal(remoteItem, baseItem) && path[0] !== "cues" && path[0] !== "discussions") pushConflict(conflicts, [...path, id], baseItem, remoteItem, undefined);
        mergedById.delete(id);
        return;
      }
      if (!remoteItem) {
        if (!equal(incomingItem, baseItem) && path[0] !== "cues" && path[0] !== "discussions") pushConflict(conflicts, [...path, id], baseItem, undefined, incomingItem);
        mergedById.delete(id);
        return;
      }
      mergedById.set(id, mergeValue(baseItem, incomingItem, remoteItem, [...path, id], conflicts) as Record<string, unknown> & { id: string });
    });

    incomingById.forEach((incomingItem, id) => {
      if (baseById.has(id)) return;
      const remoteItem = remoteById.get(id);
      if (remoteItem && !equal(remoteItem, incomingItem)) pushConflict(conflicts, [...path, id], undefined, remoteItem, incomingItem);
      mergedById.set(id, remoteItem ? mergeValue({}, incomingItem, remoteItem, [...path, id], conflicts) as Record<string, unknown> & { id: string } : incomingItem);
    });

    const incomingOrder = incoming.map((item) => item.id);
    const remoteOnlyOrder = remote.map((item) => item.id).filter((id) => !incomingById.has(id) && !baseById.has(id));
    return [...incomingOrder, ...remoteOnlyOrder].map((id) => mergedById.get(id)).filter(Boolean);
  }

  if (isRecord(base) && isRecord(incoming) && isRecord(remote)) {
    const result: Record<string, unknown> = { ...remote };
    const keys = new Set([...Object.keys(base), ...Object.keys(incoming)]);
    keys.forEach((key) => {
      const merged = mergeValue(base[key], incoming[key], remote[key], [...path, key], conflicts);
      if (merged === undefined) delete result[key];
      else result[key] = merged;
    });
    return result;
  }

  pushConflict(conflicts, path, base, remote, incoming);
  // Ownership is server-authoritative. Other same-field conflicts retain the
  // incoming value while the conflict record keeps both values for resolution.
  if (path.at(-1) === "ownerId") return remote;
  return incoming;
}

function cueVersion(state: WorkspaceState, id: string) {
  return state.cues.find((cue) => cue.id === id) ?? state.deletedCues.find((item) => item.id === id)?.cue;
}

function enforceCueAssignmentInvariants(state: WorkspaceState, ...sources: WorkspaceState[]) {
  const repair = (cue: WorkspaceState["cues"][number], id: string) => {
    const candidates = [cue, ...sources.map((source) => cueVersion(source, id)).filter(Boolean) as WorkspaceState["cues"]];
    if (cue.number === null) {
      cue.mode = "unassigned";
      return;
    }
    if (cue.mode !== "unassigned") return;
    cue.mode = candidates.find((candidate) => candidate.mode !== "unassigned")?.mode ?? "planned";
  };
  state.cues.forEach((cue) => repair(cue, cue.id));
  state.deletedCues.forEach((item) => repair(item.cue, item.id));
}

function latestDeletion(
  baseDeleted: WorkspaceState["deletedCues"][number] | undefined,
  incomingDeleted: WorkspaceState["deletedCues"][number] | undefined,
  remoteDeleted: WorkspaceState["deletedCues"][number] | undefined,
) {
  const candidates = [baseDeleted, incomingDeleted, remoteDeleted].filter(Boolean) as WorkspaceState["deletedCues"][number][];
  return candidates.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt))[0];
}

/**
 * Reconcile a cue deletion with edits that arrived through the other branch.
 * Deletion remains authoritative, but the deleted copy receives a three-way
 * merge of the cue and its cue discussions so no saved edit or reply vanishes.
 */
function preserveDeletedCueOverlaps(
  base: WorkspaceState,
  incoming: WorkspaceState,
  remote: WorkspaceState,
  state: WorkspaceState,
  conflicts: WorkspaceConflict[],
) {
  const baseCues = new Map(base.cues.map((cue) => [cue.id, cue]));
  const incomingCues = new Map(incoming.cues.map((cue) => [cue.id, cue]));
  const remoteCues = new Map(remote.cues.map((cue) => [cue.id, cue]));
  const baseDeleted = new Map(base.deletedCues.map((item) => [item.cue.id, item]));
  const incomingDeleted = new Map(incoming.deletedCues.map((item) => [item.cue.id, item]));
  const remoteDeleted = new Map(remote.deletedCues.map((item) => [item.cue.id, item]));
  const ids = new Set([...baseCues.keys(), ...incomingCues.keys(), ...remoteCues.keys(), ...incomingDeleted.keys(), ...remoteDeleted.keys()]);
  const deletedById = new Map(state.deletedCues.map((item) => [item.cue.id, item]));

  ids.forEach((id) => {
    const baseCue = baseCues.get(id);
    const incomingCue = incomingCues.get(id);
    const remoteCue = remoteCues.get(id);
    const incomingTrash = incomingDeleted.get(id);
    const remoteTrash = remoteDeleted.get(id);
    const incomingWasDeleted = !!baseCue && !incomingCue && !!incomingTrash;
    const remoteWasDeleted = !!baseCue && !remoteCue && !!remoteTrash;
    if (!incomingWasDeleted && !remoteWasDeleted) return;

    const deletion = latestDeletion(baseDeleted.get(id), incomingTrash, remoteTrash);
    if (!deletion) return;
    const incomingCueVersion = incomingCue ?? incomingTrash?.cue;
    const remoteCueVersion = remoteCue ?? remoteTrash?.cue;
    const mergedCue = baseCue && incomingCueVersion && remoteCueVersion
      ? mergeValue(baseCue, incomingCueVersion, remoteCueVersion, ["deletedCues", id, "cue"], conflicts) as WorkspaceState["cues"][number]
      : clone(incomingCueVersion ?? remoteCueVersion ?? deletion.cue);

    const relatedBase = new Map(base.discussions.filter((item) => item.cueId === id).map((item) => [item.id, item]));
    const relatedIncoming = new Map([
      ...incoming.discussions.filter((item) => item.cueId === id).map((item) => [item.id, item] as const),
      ...(incomingTrash?.discussions ?? []).map((item) => [item.id, item] as const),
    ]);
    const relatedRemote = new Map([
      ...remote.discussions.filter((item) => item.cueId === id).map((item) => [item.id, item] as const),
      ...(remoteTrash?.discussions ?? []).map((item) => [item.id, item] as const),
    ]);
    const discussionIds = new Set([...relatedBase.keys(), ...relatedIncoming.keys(), ...relatedRemote.keys()]);
    const mergedDiscussions: WorkspaceState["discussions"] = [];
    discussionIds.forEach((discussionId) => {
      const mergedDiscussion = mergeValue(
        relatedBase.get(discussionId),
        relatedIncoming.get(discussionId),
        relatedRemote.get(discussionId),
        ["deletedCues", id, "discussions", discussionId],
        conflicts,
      );
      if (mergedDiscussion) mergedDiscussions.push(mergedDiscussion as WorkspaceState["discussions"][number]);
    });

    const mergedDeletion = {
      ...deletion,
      id,
      cue: mergedCue,
      discussions: mergedDiscussions,
    };
    deletedById.set(id, mergedDeletion);
    state.cues = state.cues.filter((cue) => cue.id !== id);
    state.discussions = state.discussions.filter((discussion) => discussion.cueId !== id);
  });

  state.deletedCues = [...deletedById.values()];
  // Restoration can overlap with a saved update to the trash copy as well.
  for (const deleted of base.deletedCues) {
    const id = deleted.id;
    if (!incomingCues.has(id) && !remoteCues.has(id)) continue;
    const incomingVersion = incomingCues.get(id) ?? incomingDeleted.get(id)?.cue;
    const remoteVersion = remoteCues.get(id) ?? remoteDeleted.get(id)?.cue;
    if (!incomingVersion || !remoteVersion) continue;
    const cue = mergeValue(deleted.cue, incomingVersion, remoteVersion, ["cues", id], conflicts) as WorkspaceState["cues"][number];
    const notes = (workspace: WorkspaceState) => [...workspace.discussions.filter((note) => note.cueId === id), ...(workspace.deletedCues.find((item) => item.id === id)?.discussions ?? [])];
    const discussions = mergeValue(deleted.discussions, notes(incoming), notes(remote), ["discussions"], conflicts) as WorkspaceState["discussions"];
    state.cues = [...state.cues.filter((item) => item.id !== id), cue];
    state.discussions = [...state.discussions.filter((note) => note.cueId !== id), ...discussions];
    state.deletedCues = state.deletedCues.filter((item) => item.id !== id);
  }
}

export function mergeWorkspaceStates(base: WorkspaceState, incoming: WorkspaceState, remote: WorkspaceState) {
  const conflicts: WorkspaceConflict[] = [];
  // mergeValue may reuse unchanged branches. Clone before deletion
  // reconciliation so the merge cannot mutate a caller's snapshot.
  const state = clone(mergeValue(base, incoming, remote, [], conflicts) as WorkspaceState);
  preserveDeletedCueOverlaps(base, incoming, remote, state, conflicts);
  enforceCueAssignmentInvariants(state, base, incoming, remote);
  return { state, conflicts };
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function ensurePathSegment(segment: unknown): segment is string {
  return typeof segment === "string"
    && segment.length > 0
    && segment.length <= 200
    && !segment.includes("\0")
    && segment !== "__proto__"
    && segment !== "prototype"
    && segment !== "constructor";
}

function findArrayIndex(array: unknown[], id: string) {
  return array.findIndex((item) => isRecord(item) && item.id === id);
}

function pathParent(root: unknown, path: string[]) {
  let current: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = findArrayIndex(current, segment);
      if (index < 0) throw new Error(`Unknown workspace record: ${segment}`);
      current = current[index];
    } else if (isRecord(current)) {
      if (!hasOwn(current, segment)) throw new Error(`Unknown workspace field: ${segment}`);
      current = current[segment];
    } else {
      throw new Error("Workspace change path does not point to a record");
    }
  }
  return current;
}

function pathValue(root: unknown, path: string[]) {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = findArrayIndex(current, segment);
      if (index < 0) throw new Error(`Unknown workspace record: ${segment}`);
      current = current[index];
    } else if (isRecord(current)) {
      if (!hasOwn(current, segment)) throw new Error(`Unknown workspace field: ${segment}`);
      current = current[segment];
    } else {
      throw new Error("Workspace change path does not point to a record");
    }
  }
  return current;
}

/** Apply compact changes without mutating the input state. */
export function applyWorkspaceChanges(state: WorkspaceState, changes: WorkspaceChange[]): WorkspaceState {
  const next = clone(state);
  for (const change of changes) {
    if (!change || !Array.isArray(change.path) || change.path.length < 1 || !change.path.every(ensurePathSegment)) {
      throw new Error("Workspace change path is invalid");
    }
    if (change.op !== "set" && change.op !== "delete" && change.op !== "reorder") throw new Error("Workspace change operation is invalid");
    if ((change.op === "set" || change.op === "reorder") && !hasOwn(change, "value")) throw new Error("Workspace change is missing a value");
    if (change.op === "reorder") {
      if (!Array.isArray(change.value) || !change.value.every(ensurePathSegment)) throw new Error("Workspace reorder value is invalid");
      const current = pathValue(next, change.path);
      if (!Array.isArray(current) || !isKeyedArray(current)) throw new Error("Workspace reorder target is invalid");
      const order = change.value as string[];
      if (new Set(order).size !== order.length || order.length !== current.length || !order.every((id) => current.some((item) => item.id === id))) throw new Error("Workspace reorder must contain every record exactly once");
      const byId = new Map(current.map((item) => [item.id, item]));
      const reordered = order.map((id) => byId.get(id)!);
      if (Array.isArray(current)) current.splice(0, current.length, ...reordered);
      continue;
    }
    const parent = pathParent(next, change.path);
    const last = change.path.at(-1)!;
    if (Array.isArray(parent)) {
      const index = findArrayIndex(parent, last);
      if (change.op === "delete") {
        if (index >= 0) parent.splice(index, 1);
      } else {
        const value = clone(change.value);
        if (!isRecord(value) || value.id !== last) throw new Error("Workspace array records must retain their id");
        if (index >= 0) parent[index] = value;
        else parent.push(value);
      }
    } else if (isRecord(parent)) {
      if (change.op === "delete") delete parent[last];
      else parent[last] = clone(change.value);
    } else {
      throw new Error("Workspace change parent is invalid");
    }
  }
  return next;
}

function diffValues(base: unknown, next: unknown, path: string[], changes: WorkspaceChange[]) {
  if (equal(base, next)) return;
  if (Array.isArray(base) && Array.isArray(next) && isKeyedArray(base) && isKeyedArray(next)) {
    const baseById = new Map(base.map((item) => [item.id, item]));
    const nextById = new Map(next.map((item) => [item.id, item]));
    base.forEach((item) => {
      if (!nextById.has(item.id)) changes.push({ op: "delete", path: [...path, item.id] });
    });
    next.forEach((item) => {
      const previous = baseById.get(item.id);
      if (!previous) changes.push({ op: "set", path: [...path, item.id], value: clone(item) });
      else diffValues(previous, item, [...path, item.id], changes);
    });
    if (base.map((item) => item.id).join("\0") !== next.map((item) => item.id).join("\0")) {
      changes.push({ op: "reorder", path: [...path], value: next.map((item) => item.id) });
    }
    return;
  }
  if (isRecord(base) && isRecord(next)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
    keys.forEach((key) => {
      if (!hasOwn(next, key) || next[key] === undefined) changes.push({ op: "delete", path: [...path, key] });
      else if (!hasOwn(base, key)) changes.push({ op: "set", path: [...path, key], value: clone(next[key]) });
      else diffValues(base[key], next[key], [...path, key], changes);
    });
    return;
  }
  changes.push({ op: "set", path, value: clone(next) });
}

/** Return the minimal record/field changes between two workspace snapshots. */
export function createWorkspaceChanges(base: WorkspaceState, next: WorkspaceState): WorkspaceChange[] {
  const changes: WorkspaceChange[] = [];
  diffValues(base, next, [], changes);
  return changes;
}

export function createWorkspacePatchMutation(
  base: WorkspaceState,
  next: WorkspaceState,
  baseRevision: number,
  mutationId: string,
): WorkspacePatchMutation {
  return { baseRevision, changes: createWorkspaceChanges(base, next), mutationId };
}

function conflictFingerprint(conflict: Pick<WorkspaceConflict, "pathSegments" | "base" | "remote" | "incoming">) {
  return JSON.stringify([conflict.pathSegments, conflict.base, conflict.remote, conflict.incoming]);
}

function conflictId(fingerprint: string) {
  // FNV-1a keeps IDs deterministic so retries do not create duplicate records.
  let hash = 2166136261;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `conflict-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Add conflict records to the state while keeping retries idempotent. */
export function recordWorkspaceConflicts(
  state: WorkspaceState,
  conflicts: WorkspaceConflict[],
  createdAt = new Date().toISOString(),
  occurrenceId?: string,
): WorkspaceState {
  if (!conflicts.length) return state;
  const records = [...(state.conflicts ?? [])];
  const existing = new Map(records.map((record) => [record.id, record]));
  conflicts.forEach((conflict) => {
    const fingerprint = conflictFingerprint(conflict);
    const occurrence = conflict.occurrenceId ?? occurrenceId;
    const sameConflict = records.find((record) => {
      if (conflictFingerprint(record) !== fingerprint) return false;
      return occurrence ? record.occurrenceId === occurrence : record.status === "open" && !record.occurrenceId;
    });
    if (sameConflict?.status === "resolved" && occurrence) return;
    const identity = JSON.stringify([fingerprint, occurrence ?? (sameConflict?.status === "resolved" ? createdAt : "")]);
    const prefix = conflictId(identity);
    let id = prefix;
    let suffix = 1;
    while (existing.has(id) && conflictFingerprint(existing.get(id)!) !== fingerprint) id = `${prefix}-${suffix++}`;
    const previous = existing.get(id);
    if (previous?.status === "resolved") return;
    existing.set(id, {
      id,
      path: conflict.path,
      pathSegments: [...conflict.pathSegments],
      base: clone(conflict.base),
      remote: clone(conflict.remote),
      incoming: clone(conflict.incoming),
      ...(conflict.kind ? { kind: conflict.kind } : {}),
      ...(conflict.repaired === undefined ? {} : { repaired: clone(conflict.repaired) }),
      ...(occurrence ? { occurrenceId: occurrence } : {}),
      status: "open",
      createdAt: previous?.createdAt ?? createdAt,
    });
  });
  return { ...state, conflicts: [...existing.values()] };
}

export type WorkspaceConflictGroup = {
  key: string;
  latest: WorkspaceConflictRecord;
  records: WorkspaceConflictRecord[];
};

function isCueAssignmentConflict(record: WorkspaceConflictRecord) {
  return record.kind !== "number-repair"
    && record.pathSegments[0] === "cues"
    && (record.pathSegments.at(-1) === "number" || record.pathSegments.at(-1) === "mode");
}

function conflictGroupKey(record: WorkspaceConflictRecord) {
  // Number and mode conflicts are resolved as one invariant-safe occurrence by
  // resolveWorkspaceConflict. Do not collapse separate assignment occurrences.
  if (isCueAssignmentConflict(record)) return `assignment:${record.occurrenceId ?? record.id}:${record.path}`;
  return JSON.stringify([record.kind ?? "merge", record.pathSegments]);
}

/** Collapse intermediate saves for one exact field into one current decision. */
export function groupWorkspaceConflictRecords(records: WorkspaceConflictRecord[]): WorkspaceConflictGroup[] {
  const groups = new Map<string, Array<{ record: WorkspaceConflictRecord; index: number }>>();
  records.forEach((record, index) => {
    if (record.status !== "open") return;
    const key = conflictGroupKey(record);
    const items = groups.get(key) ?? [];
    items.push({ record, index });
    groups.set(key, items);
  });
  return [...groups.entries()].map(([key, items]) => {
    const ordered = [...items].sort((left, right) => {
      const timeDifference = Date.parse(left.record.createdAt) - Date.parse(right.record.createdAt);
      return timeDifference || left.index - right.index;
    });
    return { key, latest: ordered.at(-1)!.record, records: ordered.map((item) => item.record) };
  }).sort((left, right) => Date.parse(right.latest.createdAt) - Date.parse(left.latest.createdAt));
}

function readPath(root: unknown, path: string[]) {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = findArrayIndex(current, segment);
      if (index < 0) return { exists: false, value: undefined };
      current = current[index];
    } else if (isRecord(current) && hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return { exists: false, value: undefined };
    }
  }
  return { exists: true, value: current };
}

/** Keep recovery provenance compact: each change stores only its old value. */
export function createWorkspaceRecoveryMutation(
  base: WorkspaceState,
  next: WorkspaceState,
  baseRevision: number,
  mutationId: string,
): WorkspaceRecoveryMutation {
  return {
    version: 2,
    baseRevision,
    mutationId,
    changes: createWorkspaceChanges(base, next).map((change) => {
      const previous = readPath(base, change.path);
      return {
        ...change,
        baseExists: previous.exists,
        ...(previous.exists && previous.value !== undefined ? { baseValue: clone(previous.value) } : {}),
      };
    }),
  };
}

export function isWorkspaceRecoveryMutation(value: unknown): value is WorkspaceRecoveryMutation {
  if (!isRecord(value) || value.version !== 2 || typeof value.baseRevision !== "number" || !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0
    || typeof value.mutationId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(value.mutationId)
    || !Array.isArray(value.changes) || value.changes.length > 10_000) return false;
  return value.changes.every((change) => isRecord(change)
    && (change.op === "set" || change.op === "delete" || change.op === "reorder")
    && Array.isArray(change.path) && change.path.length >= 1 && change.path.length <= 64 && change.path.every(ensurePathSegment)
    && typeof change.baseExists === "boolean"
    && (!change.baseExists || hasOwn(change, "baseValue"))
    && (change.op === "delete" || hasOwn(change, "value"))
    && (change.op !== "reorder" || Array.isArray(change.value) && change.value.every(ensurePathSegment)));
}

function isDeletedCue(value: unknown): value is DeletedCue {
  return isRecord(value)
    && typeof value.id === "string"
    && isRecord(value.cue)
    && Array.isArray(value.discussions);
}

function recoveryPathForDeletedRecord(state: WorkspaceState, path: string[]) {
  if (path[0] === "cues" && path.length >= 3 && state.deletedCues.some((item) => item.id === path[1])) {
    return ["deletedCues", path[1], "cue", ...path.slice(2)];
  }
  if (path[0] === "discussions" && path.length >= 2) {
    const deleted = state.deletedCues.find((item) => item.discussions.some((discussion) => discussion.id === path[1]));
    if (deleted) return ["deletedCues", deleted.id, "discussions", ...path.slice(1)];
  }
  return path;
}

function mergeRecoveredDeletedCue(
  state: WorkspaceState,
  deleted: DeletedCue,
  baseCue: Cue | undefined,
  baseDiscussions: Map<string, Discussion>,
  conflicts: WorkspaceConflict[],
) {
  const remoteTrash = state.deletedCues.find((item) => item.id === deleted.id);
  const remoteCue = state.cues.find((item) => item.id === deleted.id);
  const remoteCueVersion = remoteCue ?? remoteTrash?.cue;
  const cue = baseCue && remoteCueVersion
    ? mergeValue(baseCue, deleted.cue, remoteCueVersion, ["deletedCues", deleted.id, "cue"], conflicts) as Cue
    : clone(deleted.cue);
  const remoteDiscussions = new Map<string, Discussion>([
    ...state.discussions.filter((item) => item.cueId === deleted.id).map((item) => [item.id, item] as const),
    ...(remoteTrash?.discussions ?? []).map((item) => [item.id, item] as const),
  ]);
  const localDiscussions = new Map(deleted.discussions.map((item) => [item.id, item]));
  const discussionIds = new Set([...baseDiscussions.keys(), ...localDiscussions.keys(), ...remoteDiscussions.keys()]);
  const discussions = [...discussionIds].flatMap((discussionId) => {
    const merged = mergeValue(
      baseDiscussions.get(discussionId),
      localDiscussions.get(discussionId),
      remoteDiscussions.get(discussionId),
      ["deletedCues", deleted.id, "discussions", discussionId],
      conflicts,
    );
    return merged ? [merged as Discussion] : [];
  });
  const metadata = latestDeletion(undefined, deleted, remoteTrash) ?? deleted;
  const mergedDeleted = { ...metadata, id: deleted.id, cue, discussions };
  state.cues = state.cues.filter((item) => item.id !== deleted.id);
  state.discussions = state.discussions.filter((item) => item.cueId !== deleted.id);
  state.deletedCues = [mergedDeleted, ...state.deletedCues.filter((item) => item.id !== deleted.id)];
}

function mergeRecoveredRestoredCue(
  state: WorkspaceState,
  deleted: DeletedCue,
  restoredCue: Cue,
  restoredDiscussions: Map<string, Discussion>,
  conflicts: WorkspaceConflict[],
) {
  const remoteTrash = state.deletedCues.find((item) => item.id === deleted.id);
  const remoteCue = state.cues.find((item) => item.id === deleted.id);
  const remoteCueVersion = remoteCue ?? remoteTrash?.cue;
  const cue = remoteCueVersion
    ? mergeValue(deleted.cue, restoredCue, remoteCueVersion, ["cues", deleted.id], conflicts) as Cue
    : clone(restoredCue);
  const remoteDiscussions = new Map<string, Discussion>([
    ...state.discussions.filter((item) => item.cueId === deleted.id).map((item) => [item.id, item] as const),
    ...(remoteTrash?.discussions ?? []).map((item) => [item.id, item] as const),
  ]);
  const discussionIds = new Set([...deleted.discussions.map((item) => item.id), ...restoredDiscussions.keys(), ...remoteDiscussions.keys()]);
  const discussions = [...discussionIds].flatMap((discussionId) => {
    const merged = mergeValue(
      deleted.discussions.find((item) => item.id === discussionId),
      restoredDiscussions.get(discussionId),
      remoteDiscussions.get(discussionId),
      ["discussions", discussionId],
      conflicts,
    );
    return merged ? [merged as Discussion] : [];
  });
  state.cues = [...state.cues.filter((item) => item.id !== deleted.id), cue];
  state.discussions = [...state.discussions.filter((item) => item.cueId !== deleted.id), ...discussions];
  state.deletedCues = state.deletedCues.filter((item) => item.id !== deleted.id);
}

function applyRecoveryReorder(state: WorkspaceState, path: string[], requestedOrder: unknown) {
  if (!Array.isArray(requestedOrder)) return state;
  const current = readPath(state, path).value;
  if (!Array.isArray(current) || !isKeyedArray(current)) return state;
  const currentIds = current.map((item) => item.id);
  const requestedIds = requestedOrder.filter((id): id is string => typeof id === "string" && currentIds.includes(id));
  const requestedSet = new Set(requestedIds);
  const order = [...requestedIds, ...currentIds.filter((id) => !requestedSet.has(id))];
  return applyWorkspaceChanges(state, [{ op: "reorder", path, value: order }]);
}

/** Reapply a compact recovery record to the last server state with merge provenance. */
export function rebaseWorkspaceRecoveryMutation(remote: WorkspaceState, mutation: WorkspaceRecoveryMutation) {
  let state = clone(remote);
  const conflicts: WorkspaceConflict[] = [];
  const handled = new Set<number>();
  mutation.changes.forEach((stored, index) => {
    if (stored.op !== "delete" || stored.path.length !== 2 || stored.path[0] !== "deletedCues" || !stored.baseExists || !isDeletedCue(stored.baseValue)) return;
    const restoredChange = mutation.changes.find((candidate) => candidate.op === "set"
      && candidate.path.length === 2
      && candidate.path[0] === "cues"
      && candidate.path[1] === stored.path[1]
      && isRecord(candidate.value)
      && candidate.value.id === stored.path[1]);
    if (!restoredChange || !isRecord(restoredChange.value)) return;
    const deleted = stored.baseValue;
    const restoredDiscussions = new Map<string, Discussion>();
    mutation.changes.forEach((candidate, candidateIndex) => {
      if (candidate.op === "set" && candidate.path.length === 2 && candidate.path[0] === "discussions" && isRecord(candidate.value)
        && candidate.value.cueId === deleted.id) {
        restoredDiscussions.set(candidate.path[1], candidate.value as Discussion);
        handled.add(candidateIndex);
      }
    });
    mergeRecoveredRestoredCue(state, deleted, restoredChange.value as Cue, restoredDiscussions, conflicts);
    mutation.changes.forEach((candidate, candidateIndex) => {
      if (candidate.path[0] === "cues" && candidate.path[1] === deleted.id
        || candidate.path[0] === "deletedCues" && candidate.path[1] === deleted.id
        || candidate.path[0] === "discussions" && restoredDiscussions.has(candidate.path[1])) handled.add(candidateIndex);
    });
    handled.add(index);
  });
  mutation.changes.forEach((stored) => {
    if (stored.op !== "delete" || stored.path.length !== 2 || stored.path[0] !== "cues") return;
    const deletedChange = mutation.changes.find((candidate) => candidate.op === "set"
      && candidate.path.length === 2
      && candidate.path[0] === "deletedCues"
      && candidate.path[1] === stored.path[1]
      && isDeletedCue(candidate.value));
    if (!deletedChange || !isDeletedCue(deletedChange.value)) return;
    const baseDiscussions = new Map<string, Discussion>();
    mutation.changes.forEach((candidate, candidateIndex) => {
      if (candidate.op === "delete" && candidate.path.length === 2 && candidate.path[0] === "discussions" && candidate.baseExists && isRecord(candidate.baseValue)) {
        baseDiscussions.set(candidate.path[1], candidate.baseValue as Discussion);
        handled.add(candidateIndex);
      }
    });
    const baseCue = stored.baseExists && isRecord(stored.baseValue) ? stored.baseValue as Cue : undefined;
    mergeRecoveredDeletedCue(state, deletedChange.value, baseCue, baseDiscussions, conflicts);
    mutation.changes.forEach((candidate, candidateIndex) => {
      if (candidate.path[0] === "cues" && candidate.path[1] === stored.path[1]
        || candidate.path[0] === "deletedCues" && candidate.path[1] === stored.path[1]
        || candidate.path[0] === "discussions" && baseDiscussions.has(candidate.path[1])) handled.add(candidateIndex);
    });
  });
  mutation.changes.forEach((stored, index) => {
    if (handled.has(index)) return;
    if (stored.op === "reorder") {
      try { state = applyRecoveryReorder(state, stored.path, stored.value); } catch { /* The remote collection changed shape while recovering. */ }
      return;
    }
    const path = recoveryPathForDeletedRecord(state, stored.path);
    const current = readPath(state, path);
    const incomingExists = stored.op !== "delete";
    const incomingValue = incomingExists ? stored.value : undefined;
    const baseMatches = current.exists === stored.baseExists && equal(current.value, stored.baseValue);
    const incomingMatches = current.exists === incomingExists && equal(current.value, incomingValue);
    const keepRemoteOwner = path.at(-1) === "ownerId" && !baseMatches && !incomingMatches;
    if (!baseMatches && !incomingMatches) {
      pushConflict(conflicts, path, stored.baseValue, current.value, incomingValue, "merge", undefined, mutation.mutationId);
    }
    if (!keepRemoteOwner) {
      if (stored.op === "delete") {
        try { state = applyWorkspaceChanges(state, [{ op: "delete", path }]); } catch { /* The remote record was deleted already. */ }
      } else {
        try { state = applyWorkspaceChanges(state, [{ op: stored.op, path, value: incomingValue }]); } catch { /* The remote tree no longer has this path. */ }
      }
    }
  });
  enforceCueAssignmentInvariants(state);
  return { state, conflicts };
}

/** Apply one stored choice and mark the conflict resolved for every client. */
export function resolveWorkspaceConflict(
  state: WorkspaceState,
  id: string,
  choice: "base" | "remote" | "incoming",
  resolvedBy: string,
  resolvedAt = new Date().toISOString(),
): WorkspaceState {
  const record = state.conflicts?.find((item) => item.id === id);
  if (!record || record.status === "resolved") return state;
  const value = record[choice];
  let path = [...record.pathSegments];
  if (path[0] === "cues" && state.deletedCues.some((item) => item.id === path[1])) path = ["deletedCues", path[1], "cue", ...path.slice(2)];
  if (path[0] === "discussions") {
    const deleted = state.deletedCues.find((item) => item.discussions.some((note) => note.id === path[1]));
    if (deleted) path = ["deletedCues", deleted.id, "discussions", ...path.slice(1)];
  }
  if (path[0] === "deletedCues" && !state.deletedCues.some((item) => item.id === path[1])) {
    if (path[2] === "cue") path = ["cues", path[1], ...path.slice(3)];
    else if (path[2] === "discussions") path = ["discussions", ...path.slice(3)];
  }
  const cueId = path[0] === "cues" || path[0] === "deletedCues" ? path[1] : undefined;
  const cue = cueId ? state.cues.find((item) => item.id === cueId) ?? state.deletedCues.find((item) => item.id === cueId)?.cue : undefined;
  const cueConflict = cueId && cue && (record.pathSegments.at(-1) === "number" || record.pathSegments.at(-1) === "mode")
    ? (state.conflicts ?? []).filter((item) => item.status === "open" && item.occurrenceId === record.occurrenceId && item.pathSegments[1] === cueId && (item.pathSegments.at(-1) === "number" || item.pathSegments.at(-1) === "mode"))
    : [];
  let changed: WorkspaceState;
  if (cue && cueConflict.length) {
    const numberRecord = cueConflict.find((item) => item.pathSegments.at(-1) === "number");
    const modeRecord = cueConflict.find((item) => item.pathSegments.at(-1) === "mode");
    const chosenNumber = (numberRecord ? numberRecord[choice] : cue.number) as number | string | null | undefined;
    const chosenMode = (modeRecord ? modeRecord[choice] : cue.mode) as WorkspaceState["cues"][number]["mode"];
    const number = readCueNumber(chosenNumber);
    const mode = isCueAssignmentValid(number, chosenMode) ? chosenMode : number ? (chosenMode === "implemented" ? "implemented" : "planned") : "unassigned";
    if (!isCueAssignmentValid(number, mode)) throw new Error("This cue-number resolution is not valid");
    const resolvedCueId = cueId!;
    const cuePath = state.cues.some((item) => item.id === resolvedCueId) ? ["cues", resolvedCueId] : ["deletedCues", resolvedCueId, "cue"];
    changed = applyWorkspaceChanges(state, [
      { op: "set", path: [...cuePath, "number"], value: number },
      { op: "set", path: [...cuePath, "mode"], value: mode },
    ]);
    const resolvedIds = new Set(cueConflict.map((item) => item.id));
    return {
      ...changed,
      conflicts: (changed.conflicts ?? []).map((item) => resolvedIds.has(item.id) ? { ...item, status: "resolved", resolution: choice, resolvedBy, resolvedAt } : item),
    };
  }
  changed = value === undefined
    ? applyWorkspaceChanges(state, [{ op: "delete", path }])
    : applyWorkspaceChanges(state, [{ op: "set", path, value }]);
  return {
    ...changed,
    conflicts: (changed.conflicts ?? []).map((item) => item.id === id ? { ...item, status: "resolved", resolution: choice, resolvedBy, resolvedAt } : item),
  };
}

/** Apply only the newest value for a field and archive its older intermediate saves. */
export function resolveWorkspaceConflictGroup(
  state: WorkspaceState,
  id: string,
  choice: "base" | "remote" | "incoming",
  resolvedBy: string,
  resolvedAt = new Date().toISOString(),
): WorkspaceState {
  const group = groupWorkspaceConflictRecords(state.conflicts ?? []).find((item) => item.records.some((record) => record.id === id));
  if (!group || group.latest.kind === "number-repair") return state;
  const resolved = resolveWorkspaceConflict(state, group.latest.id, choice, resolvedBy, resolvedAt);
  if (group.records.length === 1) return resolved;
  const groupedIds = new Set(group.records.map((record) => record.id));
  return {
    ...resolved,
    conflicts: (resolved.conflicts ?? []).map((record) => {
      if (!groupedIds.has(record.id) || record.id === group.latest.id || record.status === "resolved") return record;
      return { ...record, status: "resolved", resolvedBy, resolvedAt, supersededBy: group.latest.id };
    }),
  };
}

/** Close an informational repair notice without changing the repaired cue. */
export function acknowledgeWorkspaceConflictGroup(
  state: WorkspaceState,
  id: string,
  resolvedBy: string,
  resolvedAt = new Date().toISOString(),
): WorkspaceState {
  const group = groupWorkspaceConflictRecords(state.conflicts ?? []).find((item) => item.records.some((record) => record.id === id));
  if (!group || group.latest.kind !== "number-repair") return state;
  const groupedIds = new Set(group.records.map((record) => record.id));
  return {
    ...state,
    conflicts: (state.conflicts ?? []).map((record) => groupedIds.has(record.id)
      ? { ...record, status: "resolved", resolvedBy, resolvedAt, ...(record.id === group.latest.id ? {} : { supersededBy: group.latest.id }) }
      : record),
  };
}
