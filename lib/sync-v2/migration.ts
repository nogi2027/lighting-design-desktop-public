import { readCueNumber } from "../cue-numbering.ts";
import * as Y from "yjs";
import type { WorkspaceState } from "../types.ts";
import { sha256, stableJson } from "./encoding.ts";
import { YJS_TEXT_FIELDS } from "./yjs-document.ts";
import { loadSyncProjection, readCanonicalTextDocument, readSyncHead, seedSyncWorkspace } from "./server-storage.ts";

const workspaceId = "lighting-design";

export type SyncMigrationControl = {
  workspace_id: string;
  status: "locked" | "prepared" | "verified" | "enabled";
  legacy_revision: number;
  legacy_hash: string;
  normalized_hash: string | null;
  cue_count: number | null;
  started_at: string;
  verified_at: string | null;
  enabled_at: string | null;
};

type LegacyWorkspace = { payload: string; revision: number };

function byId<T extends { id: string }>(items: T[]) {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function storedCoordinate(value: number | undefined) {
  return value === undefined ? undefined : Math.round(value * 1_000_000) / 1_000_000;
}

function comparableState(state: WorkspaceState): WorkspaceState {
  const cues = (items: WorkspaceState["cues"]) => byId(items).map((cue) => ({
    ...cue,
    number: readCueNumber(cue.number),
    anchorX: storedCoordinate(cue.anchorX),
    anchorY: storedCoordinate(cue.anchorY),
    anchorOrder: storedCoordinate(cue.anchorOrder)!,
  }));
  const discussions = (items: WorkspaceState["discussions"]) => byId(items).map((discussion) => ({
    ...discussion,
    anchorX: storedCoordinate(discussion.anchorX),
    anchorY: storedCoordinate(discussion.anchorY),
    replies: byId(discussion.replies),
  }));
  return {
    ...state,
    profiles: byId(state.profiles),
    scenes: byId(state.scenes).map((scene) => ({ ...scene, startY: storedCoordinate(scene.startY)! })),
    cues: cues(state.cues),
    discussions: discussions(state.discussions),
    history: byId(state.history).map((event) => ({ ...event, anchorY: storedCoordinate(event.anchorY) })),
    inboxReads: byId(state.inboxReads),
    inboxPins: byId(state.inboxPins),
    deletedCues: byId(state.deletedCues).map((item) => ({ ...item, cue: cues([item.cue])[0], discussions: discussions(item.discussions) })),
    conflicts: byId(state.conflicts ?? []),
  };
}

function changedRows(result: D1Result<unknown> | undefined) {
  return Number(result?.meta.changes ?? 0);
}

async function legacyWorkspace(db: D1Database) {
  return db.prepare("SELECT payload,revision FROM workspace_state WHERE id=?").bind(workspaceId).first<LegacyWorkspace>();
}

export async function readSyncMigrationControl(db: D1Database) {
  return db.prepare("SELECT * FROM sync_migration_control WHERE workspace_id=?").bind(workspaceId).first<SyncMigrationControl>();
}

export async function prepareSyncMigration(db: D1Database) {
  const initial = await legacyWorkspace(db);
  if (!initial) throw new Error("The legacy workspace is unavailable.");
  const now = new Date().toISOString();
  const initialHash = await sha256(initial.payload);
  await db.prepare("INSERT OR IGNORE INTO sync_migration_control (workspace_id,status,legacy_revision,legacy_hash,normalized_hash,cue_count,started_at,verified_at,enabled_at) VALUES (?,'locked',?,?,NULL,NULL,?,NULL,NULL)")
    .bind(workspaceId, initial.revision, initialHash, now)
    .run();

  let control = await readSyncMigrationControl(db);
  if (!control) throw new Error("The migration lock could not be created.");
  const existingHead = await readSyncHead(db);
  if (control.status === "enabled" && existingHead?.write_mode === "enabled") return control;

  const frozen = await legacyWorkspace(db);
  if (!frozen) throw new Error("The frozen legacy workspace is unavailable.");
  const frozenHash = await sha256(frozen.payload);
  if (!existingHead && control.status === "locked" && (control.legacy_revision !== frozen.revision || control.legacy_hash !== frozenHash)) {
    await db.prepare("UPDATE sync_migration_control SET legacy_revision=?,legacy_hash=? WHERE workspace_id=? AND status='locked' AND NOT EXISTS (SELECT 1 FROM sync_head WHERE workspace_id=?)")
      .bind(frozen.revision, frozenHash, workspaceId, workspaceId)
      .run();
    control = (await readSyncMigrationControl(db))!;
  }
  if (control.legacy_revision !== frozen.revision || control.legacy_hash !== frozenHash) throw new Error("The legacy workspace changed after the migration lock was recorded.");

  let head = existingHead;
  if (!head) {
    try {
      head = await seedSyncWorkspace(db, JSON.parse(frozen.payload) as WorkspaceState, { writeMode: "read_only" });
    } catch (error) {
      head = await readSyncHead(db);
      if (!head) throw error;
    }
  }
  if (head.write_mode !== "read_only") throw new Error("The normalized workspace is not in read-only migration mode.");
  await db.prepare("UPDATE sync_migration_control SET status='prepared' WHERE workspace_id=? AND status='locked'").bind(workspaceId).run();
  return (await readSyncMigrationControl(db))!;
}

export async function verifySyncMigration(db: D1Database) {
  const [control, head, frozen] = await Promise.all([readSyncMigrationControl(db), readSyncHead(db), legacyWorkspace(db)]);
  if (!control || !["prepared", "verified"].includes(control.status)) throw new Error("The migration has not been prepared.");
  if (!head || head.write_mode !== "read_only") throw new Error("The workspace is not held read-only for verification.");
  if (!frozen || frozen.revision !== control.legacy_revision || await sha256(frozen.payload) !== control.legacy_hash) throw new Error("The frozen legacy workspace no longer matches the migration baseline.");

  const legacy = JSON.parse(frozen.payload) as WorkspaceState;
  const projection = await loadSyncProjection(db);
  const legacyJson = stableJson(comparableState(legacy));
  const normalizedJson = stableJson(comparableState(projection.state));
  if (normalizedJson !== legacyJson) throw new Error("The normalized workspace does not match the frozen legacy workspace.");

  const allCues = [...legacy.cues, ...legacy.deletedCues.map((item) => item.cue)];
  for (const cue of allCues) {
    const actual = await readCanonicalTextDocument(db, cue.id);
    if (!actual || actual.revision !== 0 || actual.workspace_sequence !== 0) throw new Error(`Cue text verification failed for ${cue.id}.`);
    const document = new Y.Doc({ gc: true });
    for (const field of YJS_TEXT_FIELDS) document.getText(field);
    Y.applyUpdate(document, actual.encodedState);
    if (YJS_TEXT_FIELDS.some((field) => document.getText(field).toString() !== cue[field])) throw new Error(`Cue text verification failed for ${cue.id}.`);
  }

  const normalizedHash = await sha256(normalizedJson);
  const verifiedAt = new Date().toISOString();
  await db.prepare("UPDATE sync_migration_control SET status='verified',normalized_hash=?,cue_count=?,verified_at=? WHERE workspace_id=? AND status IN ('prepared','verified')")
    .bind(normalizedHash, allCues.length, verifiedAt, workspaceId)
    .run();
  return (await readSyncMigrationControl(db))!;
}

export async function enableSyncMigration(db: D1Database) {
  const [control, head] = await Promise.all([readSyncMigrationControl(db), readSyncHead(db)]);
  if (control?.status === "enabled" && head?.write_mode === "enabled") return control;
  if (!control || control.status !== "verified" || !head || head.write_mode !== "read_only") throw new Error("The migration must pass verification before Sync v2 can be enabled.");
  const enabledAt = new Date().toISOString();
  const results = await db.batch([
    db.prepare("UPDATE sync_head SET write_mode='enabled',updated_at=? WHERE workspace_id=? AND write_mode='read_only' AND EXISTS (SELECT 1 FROM sync_migration_control WHERE workspace_id=? AND status='verified')").bind(enabledAt, workspaceId, workspaceId),
    db.prepare("UPDATE sync_migration_control SET status='enabled',enabled_at=? WHERE workspace_id=? AND status='verified' AND EXISTS (SELECT 1 FROM sync_head WHERE workspace_id=? AND write_mode='enabled')").bind(enabledAt, workspaceId, workspaceId),
  ]);
  if (results.some((result) => changedRows(result) !== 1)) throw new Error("The verified migration could not be enabled atomically.");
  return (await readSyncMigrationControl(db))!;
}

export async function abortSyncMigration(db: D1Database) {
  if (await readSyncHead(db)) throw new Error("The normalized workspace already exists; keep writes paused and fix forward.");
  const result = await db.prepare("DELETE FROM sync_migration_control WHERE workspace_id=? AND status='locked'").bind(workspaceId).run();
  if (changedRows(result) !== 1) throw new Error("There is no pre-import migration lock to remove.");
  return null;
}
