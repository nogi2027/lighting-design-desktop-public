import { formatCueNumber, readCueNumber } from "../cue-numbering.ts";
import { defaultState } from "../default-state.ts";
import { withQaFault, type QaFault } from "./qa-fault.ts";
import type { Cue, Discussion, HistoryEvent, Profile, WorkspaceConflictRecord, WorkspaceState } from "../types.ts";
import { asArrayBuffer, bytesToBase64, operationHash, sha256, stableJson } from "./encoding.ts";
import { actionTargetId, isTextAction, MAX_SYNC_PAYLOAD_CHUNK_BYTES, SYNC_PROTOCOL, type OperationEnvelope, type OperationResult, type SyncAction } from "./protocol.ts";
import { reduceStructuredAction, type ProjectionVersions, type StructuredReduction } from "./reducer.ts";
import { createCanonicalTextDocument, createTextReplacementUpdate, decodeTextAction, validateAndApplyTextUpdate } from "./yjs-document.ts";
import { operationNeedsAttention } from "./notifications.ts";

export const MAX_CANONICAL_TEXT_BYTES = 1_500_000;

export type SyncHead = {
  workspace_id: string;
  epoch: string;
  sequence: number;
  write_mode: "legacy" | "enabled" | "read_only";
  protocol_min: number;
  protocol_max: number;
  commit_token: string | null;
  updated_at: string;
};

export type LoadedProjection = { state: WorkspaceState; versions: ProjectionVersions };

export type TextDocumentVersion = {
  workspace_id: string;
  epoch: string;
  sequence: number;
  revision: number | null;
  state_hash: string | null;
};

type CueRow = {
  workspace_id: string; id: string; position_version: number; lifecycle_version: number; assignment_version: number; blackout_version: number; text_revision: number;
  number: string | null; mode: Cue["mode"]; blackout: number; scene_id: string; page: number; anchor_type: Cue["anchorType"];
  selected_text: string; enclosing_line: string; anchor_x_micros: number | null; anchor_y_micros: number | null; anchor_order_micros: number;
  owner_id: string | null; deleted_at: string | null; deleted_by: string | null; title: string; description: string; technical_notes: string;
};

class CommitInvariantError extends Error {}

function changedRows(result: D1Result<unknown> | undefined) {
  return Number(result?.meta.changes ?? 0);
}

function requireSingleRowEffects(results: D1Result<unknown>[], start = 1) {
  for (let index = start; index < results.length; index += 1) {
    if (changedRows(results[index]) !== 1) throw new CommitInvariantError(`Sync commit statement ${index} changed an unexpected number of rows.`);
  }
}
type SceneRow = { id: string; version: number; number: string; name: string; page_start: number; start_y_micros: number; page_end: number; owner_id: string | null };
type ProfileRow = Profile & { version: number };
type DiscussionRow = { id: string; version: number; target_type: Discussion["targetType"]; cue_id: string | null; scene_id: string | null; page: number | null; anchor_x_micros: number | null; anchor_y_micros: number | null; selected_text: string | null; enclosing_line: string | null; author_id: string; content: string; created_at: string; resolved: number; resolved_by: string | null };
type ReplyRow = { id: string; discussion_id: string; author_id: string; content: string; created_at: string };
type ActivityRow = { id: string; cue_id: string | null; discussion_id: string | null; reply_id: string | null; scene_id: string | null; page: number | null; anchor_y_micros: number | null; scene_ids: string | null; target_profile_ids: string | null; actor_id: string; type: HistoryEvent["type"]; text: string; created_at: string };

function micros(value: number | undefined) {
  return value === undefined ? null : Math.round(value * 1_000_000);
}

function fromMicros(value: number | null) {
  return value === null ? undefined : value / 1_000_000;
}

function parseStringArray(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function rows<T>(result: D1Result<unknown>) {
  return (result.results ?? []) as T[];
}

async function payloadChunks(payload: Uint8Array) {
  const chunks: Array<{ payload: Uint8Array; hash: string }> = [];
  for (let offset = 0; offset < payload.byteLength; offset += MAX_SYNC_PAYLOAD_CHUNK_BYTES) {
    const chunk = payload.subarray(offset, offset + MAX_SYNC_PAYLOAD_CHUNK_BYTES);
    chunks.push({ payload: chunk, hash: await sha256(chunk) });
  }
  return chunks;
}

function joinChunks(chunks: Uint8Array[], expectedBytes: number) {
  const value = new Uint8Array(expectedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== expectedBytes) throw new Error("The canonical text chunk length is invalid.");
  return value;
}

export async function readCanonicalTextDocument(db: D1Database, cueId: string) {
  type ManifestRow = { revision: number; workspace_sequence: number; state_vector: ArrayBuffer; state_hash: string; chunk_count: number; encoded_bytes: number; update_count: number; update_bytes: number; updated_at: string };
  type ChunkRow = { revision: number; chunk_index: number; payload: ArrayBuffer; payload_hash: string };
  const [manifestResult, chunkResult] = await db.batch([
    db.prepare("SELECT revision,workspace_sequence,state_vector,state_hash,chunk_count,encoded_bytes,update_count,update_bytes,updated_at FROM sync_text_documents WHERE workspace_id=? AND cue_id=?").bind("lighting-design", cueId),
    db.prepare("SELECT revision,chunk_index,payload,payload_hash FROM sync_text_document_chunks WHERE workspace_id=? AND cue_id=? ORDER BY revision,chunk_index").bind("lighting-design", cueId),
  ]);
  const row = (manifestResult.results?.[0] as ManifestRow | undefined) ?? null;
  if (!row) return null;
  if (row.encoded_bytes < 0 || row.encoded_bytes > MAX_CANONICAL_TEXT_BYTES || row.chunk_count < 1 || row.chunk_count > Math.ceil(MAX_CANONICAL_TEXT_BYTES / MAX_SYNC_PAYLOAD_CHUNK_BYTES)) throw new Error("The canonical text manifest exceeds its safe bound.");
  const chunkRows = (chunkResult.results ?? []) as ChunkRow[];
  if (chunkRows.length !== row.chunk_count || chunkRows.some((chunk, index) => chunk.revision !== row.revision || chunk.chunk_index !== index)) throw new Error("The canonical text chunks are incomplete.");
  const chunks = chunkRows.map((chunk) => new Uint8Array(chunk.payload));
  for (let index = 0; index < chunks.length; index += 1) if (await sha256(chunks[index]) !== chunkRows[index].payload_hash) throw new Error("A canonical text chunk failed its hash check.");
  const encodedState = joinChunks(chunks, row.encoded_bytes);
  if (await sha256(encodedState) !== row.state_hash) throw new Error("The canonical text document failed its hash check.");
  return { ...row, encodedState };
}

export async function readTextDocumentVersion(db: D1Database, cueId: string) {
  return db.prepare(`SELECT h.workspace_id,h.epoch,h.sequence,d.revision,d.state_hash
    FROM sync_head h
    LEFT JOIN sync_text_documents d ON d.workspace_id=h.workspace_id AND d.cue_id=?
    WHERE h.workspace_id=?`).bind(cueId, "lighting-design").first<TextDocumentVersion>();
}

export async function readSyncHead(db: D1Database) {
  return db.prepare("SELECT * FROM sync_head WHERE workspace_id = ?").bind("lighting-design").first<SyncHead>();
}

export async function loadSyncProjection(db: D1Database, forAction?: SyncAction): Promise<LoadedProjection> {
  // Status/blackout changes only read their target cue. Numbering, placement,
  // deletion and ownership operations still need the complete projection.
  const localCueId = forAction?.type === "setBlackout" || forAction?.type === "setCueMode" ? forAction.cueId : null;
  const statements: D1PreparedStatement[] = [
    db.prepare("SELECT id, version, name, role, initials, color FROM sync_profiles WHERE workspace_id = ? ORDER BY id").bind("lighting-design"),
    db.prepare("SELECT id, version, number, name, page_start, start_y_micros, page_end, owner_id FROM sync_scenes WHERE workspace_id = ? ORDER BY page_start, start_y_micros, id").bind("lighting-design"),
    localCueId
      ? db.prepare("SELECT * FROM sync_cues WHERE workspace_id = ? AND id = ?").bind("lighting-design", localCueId)
      : db.prepare("SELECT * FROM sync_cues WHERE workspace_id = ? ORDER BY page, anchor_order_micros, id").bind("lighting-design"),
    db.prepare(`SELECT * FROM sync_discussions WHERE workspace_id = ?${localCueId ? " AND 0" : ""} ORDER BY created_at, id`).bind("lighting-design"),
    db.prepare(`SELECT * FROM sync_replies WHERE workspace_id = ?${localCueId ? " AND 0" : ""} ORDER BY created_at, id`).bind("lighting-design"),
  ];
  const inboxAction = forAction?.type === "setInboxRead" || forAction?.type === "setInboxPinned" ? forAction : undefined;
  if (!forAction) {
    statements.push(
      db.prepare("SELECT * FROM sync_activity WHERE workspace_id = ? ORDER BY created_at DESC, id").bind("lighting-design"),
      db.prepare("SELECT workspace_id, event_id, profile_id, read_at FROM sync_inbox_reads WHERE workspace_id = ? ORDER BY event_id, profile_id").bind("lighting-design"),
      db.prepare("SELECT workspace_id, event_id, profile_id, pinned_at FROM sync_inbox_pins WHERE workspace_id = ? ORDER BY event_id, profile_id").bind("lighting-design"),
      db.prepare("SELECT payload FROM sync_conflicts WHERE workspace_id = ? ORDER BY created_at, id").bind("lighting-design"),
    );
  } else if (inboxAction?.eventIds.length) {
    const eventIds = [...new Set(inboxAction.eventIds)];
    const placeholders = eventIds.map(() => "?").join(",");
    statements.push(db.prepare(`SELECT * FROM sync_activity WHERE workspace_id = ? AND id IN (${placeholders}) ORDER BY created_at DESC, id`).bind("lighting-design", ...eventIds));
    if (inboxAction.type === "setInboxRead") statements.push(db.prepare(`SELECT workspace_id, event_id, profile_id, read_at FROM sync_inbox_reads WHERE workspace_id = ? AND profile_id = ? AND event_id IN (${placeholders}) ORDER BY event_id`).bind("lighting-design", inboxAction.profileId, ...eventIds));
    if (inboxAction.type === "setInboxPinned") statements.push(db.prepare(`SELECT workspace_id, event_id, profile_id, pinned_at FROM sync_inbox_pins WHERE workspace_id = ? AND profile_id = ? AND event_id IN (${placeholders}) ORDER BY event_id`).bind("lighting-design", inboxAction.profileId, ...eventIds));
  }
  const results = await db.batch(statements);
  const [profilesResult, scenesResult, cuesResult, discussionsResult, repliesResult] = results;
  const activityResult = results[5];
  const readsResult = !forAction ? results[6] : inboxAction?.type === "setInboxRead" ? results[6] : undefined;
  const pinsResult = !forAction ? results[7] : inboxAction?.type === "setInboxPinned" ? results[6] : undefined;
  const conflictsResult = !forAction ? results[8] : undefined;
  const profileRows = rows<ProfileRow>(profilesResult);
  const sceneRows = rows<SceneRow>(scenesResult);
  const cueRows = rows<CueRow>(cuesResult);
  const discussionRows = rows<DiscussionRow>(discussionsResult);
  const replyRows = rows<ReplyRow>(repliesResult);
  const activityRows = activityResult ? rows<ActivityRow>(activityResult) : [];
  const replies = new Map<string, Discussion["replies"]>();
  for (const row of replyRows) replies.set(row.discussion_id, [...(replies.get(row.discussion_id) ?? []), { id: row.id, authorId: row.author_id, content: row.content, createdAt: row.created_at }]);
  const discussions: Discussion[] = discussionRows.map((row) => ({
    id: row.id, targetType: row.target_type, cueId: row.cue_id ?? undefined, sceneId: row.scene_id ?? undefined, page: row.page ?? undefined,
    anchorX: fromMicros(row.anchor_x_micros), anchorY: fromMicros(row.anchor_y_micros), selectedText: row.selected_text ?? undefined,
    enclosingLine: row.enclosing_line ?? undefined, authorId: row.author_id, content: row.content, createdAt: row.created_at,
    resolved: !!row.resolved, resolvedBy: row.resolved_by ?? undefined, replies: replies.get(row.id) ?? [],
  }));
  const cues = cueRows.map<Cue>((row) => ({
    id: row.id, number: readCueNumber(row.number), title: row.title, description: row.description, technicalNotes: row.technical_notes, mode: row.mode,
    blackout: !!row.blackout, sceneId: row.scene_id, page: row.page, anchorType: row.anchor_type, selectedText: row.selected_text,
    enclosingLine: row.enclosing_line, anchorX: fromMicros(row.anchor_x_micros), anchorY: fromMicros(row.anchor_y_micros),
    anchorOrder: row.anchor_order_micros / 1_000_000, ownerId: row.owner_id ?? undefined,
  }));
  const activeCueIds = new Set(cueRows.filter((row) => !row.deleted_at).map((row) => row.id));
  const deletedCueIds = new Set(cueRows.filter((row) => !!row.deleted_at).map((row) => row.id));
  const activeDiscussions = discussions.filter((item) => !item.cueId || !deletedCueIds.has(item.cueId));
  const state: WorkspaceState = {
    schemaVersion: defaultState.schemaVersion,
    document: defaultState.document,
    profiles: profileRows.map((row) => ({ id: row.id, name: row.name, role: row.role, initials: row.initials, color: row.color })),
    scenes: sceneRows.map((row) => ({ id: row.id, number: row.number, name: row.name, pageStart: row.page_start, startY: row.start_y_micros / 1_000_000, pageEnd: row.page_end, ownerId: row.owner_id })),
    cues: cues.filter((cue) => activeCueIds.has(cue.id)),
    discussions: activeDiscussions,
    history: activityRows.map((row) => ({ id: row.id, cueId: row.cue_id ?? undefined, discussionId: row.discussion_id ?? undefined, replyId: row.reply_id ?? undefined, sceneId: row.scene_id ?? undefined, page: row.page ?? undefined, anchorY: fromMicros(row.anchor_y_micros), sceneIds: parseStringArray(row.scene_ids), targetProfileIds: parseStringArray(row.target_profile_ids), actorId: row.actor_id, type: row.type, text: row.text, createdAt: row.created_at })),
    inboxReads: readsResult ? rows<{ event_id: string; profile_id: string; read_at: string }>(readsResult).map((row) => ({ id: `read-${row.profile_id}-${row.event_id}`.slice(0, 200), eventId: row.event_id, profileId: row.profile_id, readAt: row.read_at })) : [],
    inboxPins: pinsResult ? rows<{ event_id: string; profile_id: string; pinned_at: string }>(pinsResult).map((row) => ({ id: `pin-${row.profile_id}-${row.event_id}`.slice(0, 200), eventId: row.event_id, profileId: row.profile_id, pinnedAt: row.pinned_at })) : [],
    deletedCues: cueRows.filter((row) => !!row.deleted_at).map((row) => ({ id: row.id, cue: cues.find((cue) => cue.id === row.id)!, discussions: discussions.filter((item) => item.cueId === row.id), deletedAt: row.deleted_at!, deletedBy: row.deleted_by! })),
    conflicts: conflictsResult ? rows<{ payload: string }>(conflictsResult).flatMap((row) => { try { return [JSON.parse(row.payload) as WorkspaceConflictRecord]; } catch { return []; } }) : [],
  };
  return {
    state,
    versions: {
      cues: Object.fromEntries(cueRows.map((row) => [row.id, { position: row.position_version, lifecycle: row.lifecycle_version, assignment: row.assignment_version, blackout: row.blackout_version }])),
      scenes: Object.fromEntries(sceneRows.map((row) => [row.id, row.version])),
      profiles: Object.fromEntries(profileRows.map((row) => [row.id, row.version])),
      discussions: Object.fromEntries(discussionRows.map((row) => [row.id, row.version])),
    },
  };
}

function cueStatement(db: D1Database, cue: Cue, deletedAt: string | null, deletedBy: string | null, versions: { position: number; lifecycle: number; assignment: number; blackout: number }, textRevision = 0) {
  return db.prepare("INSERT INTO sync_cues (workspace_id,id,position_version,lifecycle_version,assignment_version,blackout_version,text_revision,number,mode,blackout,scene_id,page,anchor_type,selected_text,enclosing_line,anchor_x_micros,anchor_y_micros,anchor_order_micros,owner_id,deleted_at,deleted_by,title,description,technical_notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind("lighting-design", cue.id, versions.position, versions.lifecycle, versions.assignment, versions.blackout, textRevision, cue.number === null ? null : formatCueNumber(cue.number), cue.mode, cue.blackout ? 1 : 0, cue.sceneId, cue.page, cue.anchorType, cue.selectedText, cue.enclosingLine, micros(cue.anchorX), micros(cue.anchorY), micros(cue.anchorOrder), cue.ownerId ?? null, deletedAt, deletedBy, cue.title, cue.description, cue.technicalNotes);
}

function discussionStatement(db: D1Database, discussion: Discussion, version = 1) {
  return db.prepare("INSERT INTO sync_discussions (workspace_id,id,version,target_type,cue_id,scene_id,page,anchor_x_micros,anchor_y_micros,selected_text,enclosing_line,author_id,content,created_at,resolved,resolved_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind("lighting-design", discussion.id, version, discussion.targetType ?? (discussion.cueId ? "cue" : discussion.sceneId ? "scene" : "script"), discussion.cueId ?? null, discussion.sceneId ?? null, discussion.page ?? null, micros(discussion.anchorX), micros(discussion.anchorY), discussion.selectedText ?? null, discussion.enclosingLine ?? null, discussion.authorId, discussion.content, discussion.createdAt, discussion.resolved ? 1 : 0, discussion.resolvedBy ?? null);
}

function activityStatement(db: D1Database, event: HistoryEvent, sequence: number | null = null) {
  return db.prepare("INSERT INTO sync_activity (workspace_id,id,sequence,cue_id,discussion_id,reply_id,scene_id,page,anchor_y_micros,scene_ids,target_profile_ids,actor_id,type,text,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind("lighting-design", event.id, sequence, event.cueId ?? null, event.discussionId ?? null, event.replyId ?? null, event.sceneId ?? null, event.page ?? null, micros(event.anchorY), event.sceneIds ? JSON.stringify(event.sceneIds) : null, event.targetProfileIds ? JSON.stringify(event.targetProfileIds) : null, event.actorId, event.type ?? "legacy", event.text, event.createdAt);
}

export async function seedSyncWorkspace(db: D1Database, state: WorkspaceState, options?: { epoch?: string; writeMode?: SyncHead["write_mode"] }) {
  const epoch = options?.epoch ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const existing = await readSyncHead(db);
  if (existing) return existing;
  const allCues = [...state.cues, ...state.deletedCues.map((item) => item.cue)];
  const documents = await Promise.all(allCues.map(async (cue) => {
    const document = await createCanonicalTextDocument(cue);
    return { cue, document, chunks: await payloadChunks(document.encodedState) };
  }));
  const statements: D1PreparedStatement[] = [
    db.prepare("INSERT INTO sync_head (workspace_id,epoch,sequence,write_mode,protocol_min,protocol_max,commit_token,updated_at) VALUES (?,?,0,?,2,2,NULL,?)").bind("lighting-design", epoch, options?.writeMode ?? "legacy", now),
    ...state.profiles.map((profile) => db.prepare("INSERT INTO sync_profiles (workspace_id,id,version,name,role,initials,color) VALUES (?,?,1,?,?,?,?)").bind("lighting-design", profile.id, profile.name, profile.role, profile.initials, profile.color)),
    ...state.scenes.map((scene) => db.prepare("INSERT INTO sync_scenes (workspace_id,id,version,number,name,page_start,start_y_micros,page_end,owner_id) VALUES (?,?,1,?,?,?,?,?,?)").bind("lighting-design", scene.id, scene.number, scene.name, scene.pageStart, micros(scene.startY), scene.pageEnd, scene.ownerId)),
    ...state.cues.map((cue) => cueStatement(db, cue, null, null, { position: 1, lifecycle: 1, assignment: 1, blackout: 1 })),
    ...state.deletedCues.map((item) => cueStatement(db, item.cue, item.deletedAt, item.deletedBy, { position: 1, lifecycle: 1, assignment: 1, blackout: 1 })),
    ...[...state.discussions, ...state.deletedCues.flatMap((item) => item.discussions)].map((discussion) => discussionStatement(db, discussion)),
    ...[...state.discussions, ...state.deletedCues.flatMap((item) => item.discussions)].flatMap((discussion) => discussion.replies.map((reply) => db.prepare("INSERT INTO sync_replies (workspace_id,id,discussion_id,author_id,content,created_at) VALUES (?,?,?,?,?,?)").bind("lighting-design", reply.id, discussion.id, reply.authorId, reply.content, reply.createdAt))),
    ...state.history.map((event) => activityStatement(db, event)),
    ...state.inboxReads.map((receipt) => db.prepare("INSERT INTO sync_inbox_reads (workspace_id,event_id,profile_id,read_at) VALUES (?,?,?,?)").bind("lighting-design", receipt.eventId, receipt.profileId, receipt.readAt)),
    ...state.inboxPins.map((pin) => db.prepare("INSERT INTO sync_inbox_pins (workspace_id,event_id,profile_id,pinned_at) VALUES (?,?,?,?)").bind("lighting-design", pin.eventId, pin.profileId, pin.pinnedAt)),
    ...(state.conflicts ?? []).map((conflict) => db.prepare("INSERT INTO sync_conflicts (workspace_id,id,payload,created_at) VALUES (?,?,?,?)").bind("lighting-design", conflict.id, JSON.stringify(conflict), conflict.createdAt)),
    ...documents.flatMap(({ cue, document, chunks }) => [
      db.prepare("INSERT INTO sync_text_documents (workspace_id,cue_id,revision,workspace_sequence,state_vector,state_hash,chunk_count,encoded_bytes,update_count,update_bytes,updated_at) VALUES (?,?,0,0,?,?,?,?,0,0,?)").bind("lighting-design", cue.id, asArrayBuffer(document.stateVector), document.hash, chunks.length, document.encodedState.byteLength, now),
      ...chunks.map((chunk, index) => db.prepare("INSERT INTO sync_text_document_chunks (workspace_id,cue_id,revision,chunk_index,payload,payload_hash) VALUES (?,?,0,?,?,?)").bind("lighting-design", cue.id, index, asArrayBuffer(chunk.payload), chunk.hash)),
      db.prepare("INSERT INTO sync_text_checkpoints (workspace_id,cue_id,revision,sequence,state_vector,state_hash,chunk_count,encoded_bytes,created_at) VALUES (?,?,0,0,?,?,?,?,?)").bind("lighting-design", cue.id, asArrayBuffer(document.stateVector), document.hash, chunks.length, document.encodedState.byteLength, now),
      ...chunks.map((chunk, index) => db.prepare("INSERT INTO sync_text_checkpoint_chunks (workspace_id,cue_id,revision,chunk_index,payload,payload_hash) VALUES (?,?,0,?,?,?)").bind("lighting-design", cue.id, index, asArrayBuffer(chunk.payload), chunk.hash)),
      db.prepare("INSERT INTO sync_text_history (workspace_id,cue_id,revision,sequence,operation_id,title,description,technical_notes,actor_id,created_at) VALUES (?,?,0,0,?,?,?,?,?,?)").bind("lighting-design", cue.id, `initial-${cue.id}`, cue.title, cue.description, cue.technicalNotes, state.profiles[0]?.id ?? "system", now),
    ]),
  ];
  await db.batch(statements);
  return (await readSyncHead(db))!;
}

export async function seedSyncWorkspaceFromLegacy(db: D1Database, options?: { epoch?: string; writeMode?: SyncHead["write_mode"] }) {
  const row = await db.prepare("SELECT payload FROM workspace_state WHERE id = ?").bind("lighting-design").first<{ payload: string }>();
  if (!row) throw new Error("The legacy workspace is unavailable.");
  return seedSyncWorkspace(db, JSON.parse(row.payload) as WorkspaceState, options);
}

async function readReceipt(db: D1Database, operationId: string) {
  return db.prepare("SELECT request_hash,status,sequence,code,message,outcome,created_at FROM sync_receipts WHERE workspace_id = ? AND operation_id = ?").bind("lighting-design", operationId).first<{ request_hash: string; status: OperationResult["status"]; sequence: number | null; code: string | null; message: string | null; outcome: string; created_at: string }>();
}

function receiptResult(head: SyncHead, envelope: OperationEnvelope, receipt: NonNullable<Awaited<ReturnType<typeof readReceipt>>>): OperationResult {
  let outcome: Record<string, unknown> = {};
  try { outcome = JSON.parse(receipt.outcome) as Record<string, unknown>; } catch { /* keep a usable receipt */ }
  return { protocol: SYNC_PROTOCOL, workspaceId: envelope.workspaceId, epoch: head.epoch, operationId: envelope.operationId, status: receipt.status, sequence: receipt.sequence ?? undefined, code: receipt.code ?? undefined, message: receipt.message ?? undefined, outcome };
}

function terminalResult(head: SyncHead, envelope: OperationEnvelope, status: OperationResult["status"], code?: string, message?: string, outcome: Record<string, unknown> = {}): OperationResult {
  return { protocol: SYNC_PROTOCOL, workspaceId: envelope.workspaceId, epoch: head.epoch, operationId: envelope.operationId, status, sequence: head.sequence, code, message, outcome };
}

async function missingDependency(db: D1Database, dependsOn: string[]) {
  if (!dependsOn.length) return null;
  const unique = [...new Set(dependsOn)];
  const placeholders = unique.map(() => "?").join(",");
  const found = await db.prepare(`SELECT operation_id FROM sync_receipts WHERE workspace_id = ? AND operation_id IN (${placeholders})`).bind("lighting-design", ...unique).all<{ operation_id: string }>();
  const settled = new Set((found.results ?? []).map((row) => row.operation_id));
  // Dependencies order operations; they do not require an earlier operation to
  // succeed. A stored terminal receipt means the earlier request has settled,
  // so later work must be allowed to validate against the current workspace.
  return unique.find((id) => !settled.has(id)) ?? null;
}

function cueRowFor(state: WorkspaceState, cueId: string) {
  const cue = state.cues.find((item) => item.id === cueId);
  if (cue) return { cue, deletedAt: null, deletedBy: null };
  const deleted = state.deletedCues.find((item) => item.id === cueId);
  return deleted ? { cue: deleted.cue, deletedAt: deleted.deletedAt, deletedBy: deleted.deletedBy } : null;
}

function guardSuffix(expectedSequence: number, attempt: string) {
  return { sql: "workspace_id = ? AND epoch = ? AND sequence = ? AND commit_token = ?", values: ["lighting-design", "__EPOCH__", expectedSequence + 1, attempt] as unknown[] };
}

function changedIds<T extends { id: string }>(before: T[], after: T[]) {
  const previous = new Map(before.map((item) => [item.id, stableJson(item)]));
  return after.filter((item) => previous.get(item.id) !== stableJson(item)).map((item) => item.id);
}

function appendStructuredEffectStatements(db: D1Database, before: LoadedProjection, reduction: StructuredReduction, head: SyncHead, attempt: string) {
  const guard = guardSuffix(head.sequence, attempt);
  guard.values[1] = head.epoch;
  const statements: D1PreparedStatement[] = [];
  const cueIds = new Set([
    ...changedIds(before.state.cues, reduction.state.cues),
    ...changedIds(before.state.deletedCues.map((item) => item.cue), reduction.state.deletedCues.map((item) => item.cue)),
    ...before.state.cues.filter((cue) => !reduction.state.cues.some((item) => item.id === cue.id)).map((cue) => cue.id),
    ...reduction.state.cues.filter((cue) => !before.state.cues.some((item) => item.id === cue.id)).map((cue) => cue.id),
  ]);
  for (const cueId of cueIds) {
    const row = cueRowFor(reduction.state, cueId);
    if (!row) continue;
    const previous = before.versions.cues[cueId] ?? { position: 0, lifecycle: 0, assignment: 0, blackout: 0 };
    const bumps = reduction.bumps.cues?.[cueId] ?? {};
    const version = { position: bumps.position ?? previous.position, lifecycle: bumps.lifecycle ?? previous.lifecycle, assignment: bumps.assignment ?? previous.assignment, blackout: bumps.blackout ?? previous.blackout };
    if (before.versions.cues[cueId]) {
      statements.push(db.prepare(`UPDATE sync_cues SET position_version=?,lifecycle_version=?,assignment_version=?,blackout_version=?,number=?,mode=?,blackout=?,scene_id=?,page=?,anchor_type=?,selected_text=?,enclosing_line=?,anchor_x_micros=?,anchor_y_micros=?,anchor_order_micros=?,owner_id=?,deleted_at=?,deleted_by=?,title=?,description=?,technical_notes=? WHERE workspace_id=? AND id=? AND EXISTS (SELECT 1 FROM sync_head WHERE ${guard.sql})`)
        .bind(version.position, version.lifecycle, version.assignment, version.blackout, row.cue.number, row.cue.mode, row.cue.blackout ? 1 : 0, row.cue.sceneId, row.cue.page, row.cue.anchorType, row.cue.selectedText, row.cue.enclosingLine, micros(row.cue.anchorX), micros(row.cue.anchorY), micros(row.cue.anchorOrder), row.cue.ownerId ?? null, row.deletedAt, row.deletedBy, row.cue.title, row.cue.description, row.cue.technicalNotes, "lighting-design", cueId, ...guard.values));
    } else {
      statements.push(db.prepare(`INSERT INTO sync_cues (workspace_id,id,position_version,lifecycle_version,assignment_version,blackout_version,text_revision,number,mode,blackout,scene_id,page,anchor_type,selected_text,enclosing_line,anchor_x_micros,anchor_y_micros,anchor_order_micros,owner_id,deleted_at,deleted_by,title,description,technical_notes) SELECT ?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM sync_head WHERE ${guard.sql}`)
        .bind("lighting-design", cueId, version.position, version.lifecycle, version.assignment, version.blackout, row.cue.number, row.cue.mode, row.cue.blackout ? 1 : 0, row.cue.sceneId, row.cue.page, row.cue.anchorType, row.cue.selectedText, row.cue.enclosingLine, micros(row.cue.anchorX), micros(row.cue.anchorY), micros(row.cue.anchorOrder), row.cue.ownerId ?? null, row.deletedAt, row.deletedBy, row.cue.title, row.cue.description, row.cue.technicalNotes, ...guard.values));
    }
  }
  for (const sceneId of changedIds(before.state.scenes, reduction.state.scenes)) {
    const scene = reduction.state.scenes.find((item) => item.id === sceneId)!;
    statements.push(db.prepare(`UPDATE sync_scenes SET version=?,owner_id=? WHERE workspace_id=? AND id=? AND EXISTS (SELECT 1 FROM sync_head WHERE ${guard.sql})`).bind(reduction.bumps.scenes?.[sceneId] ?? before.versions.scenes[sceneId], scene.ownerId, "lighting-design", sceneId, ...guard.values));
  }
  for (const profileId of changedIds(before.state.profiles, reduction.state.profiles)) {
    const profile = reduction.state.profiles.find((item) => item.id === profileId)!;
    if (before.versions.profiles[profileId]) statements.push(db.prepare(`UPDATE sync_profiles SET version=?,name=?,role=?,initials=?,color=? WHERE workspace_id=? AND id=? AND EXISTS (SELECT 1 FROM sync_head WHERE ${guard.sql})`).bind(reduction.bumps.profiles?.[profileId] ?? before.versions.profiles[profileId], profile.name, profile.role, profile.initials, profile.color, "lighting-design", profileId, ...guard.values));
    else statements.push(db.prepare(`INSERT INTO sync_profiles (workspace_id,id,version,name,role,initials,color) SELECT ?,?,?,?,?,?,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", profileId, reduction.bumps.profiles?.[profileId] ?? 1, profile.name, profile.role, profile.initials, profile.color, ...guard.values));
  }
  const beforeDiscussions = [...before.state.discussions, ...before.state.deletedCues.flatMap((item) => item.discussions)];
  const afterDiscussions = [...reduction.state.discussions, ...reduction.state.deletedCues.flatMap((item) => item.discussions)];
  for (const discussionId of changedIds(beforeDiscussions, afterDiscussions)) {
    const discussion = afterDiscussions.find((item) => item.id === discussionId)!;
    const version = reduction.bumps.discussions?.[discussionId] ?? before.versions.discussions[discussionId] ?? 1;
    if (before.versions.discussions[discussionId]) statements.push(db.prepare(`UPDATE sync_discussions SET version=?,target_type=?,cue_id=?,scene_id=?,page=?,anchor_x_micros=?,anchor_y_micros=?,selected_text=?,enclosing_line=?,author_id=?,content=?,created_at=?,resolved=?,resolved_by=? WHERE workspace_id=? AND id=? AND EXISTS (SELECT 1 FROM sync_head WHERE ${guard.sql})`).bind(version, discussion.targetType ?? (discussion.cueId ? "cue" : discussion.sceneId ? "scene" : "script"), discussion.cueId ?? null, discussion.sceneId ?? null, discussion.page ?? null, micros(discussion.anchorX), micros(discussion.anchorY), discussion.selectedText ?? null, discussion.enclosingLine ?? null, discussion.authorId, discussion.content, discussion.createdAt, discussion.resolved ? 1 : 0, discussion.resolvedBy ?? null, "lighting-design", discussionId, ...guard.values));
    else statements.push(db.prepare(`INSERT INTO sync_discussions (workspace_id,id,version,target_type,cue_id,scene_id,page,anchor_x_micros,anchor_y_micros,selected_text,enclosing_line,author_id,content,created_at,resolved,resolved_by) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", discussion.id, version, discussion.targetType ?? (discussion.cueId ? "cue" : discussion.sceneId ? "scene" : "script"), discussion.cueId ?? null, discussion.sceneId ?? null, discussion.page ?? null, micros(discussion.anchorX), micros(discussion.anchorY), discussion.selectedText ?? null, discussion.enclosingLine ?? null, discussion.authorId, discussion.content, discussion.createdAt, discussion.resolved ? 1 : 0, discussion.resolvedBy ?? null, ...guard.values));
    const priorReplies = beforeDiscussions.find((item) => item.id === discussionId)?.replies ?? [];
    for (const reply of discussion.replies.filter((item) => !priorReplies.some((old) => old.id === item.id))) statements.push(db.prepare(`INSERT INTO sync_replies (workspace_id,id,discussion_id,author_id,content,created_at) SELECT ?,?,?,?,?,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", reply.id, discussion.id, reply.authorId, reply.content, reply.createdAt, ...guard.values));
  }
  const newHistory = reduction.state.history.filter((event) => !before.state.history.some((item) => item.id === event.id));
  for (const event of newHistory) statements.push(db.prepare(`INSERT INTO sync_activity (workspace_id,id,sequence,cue_id,discussion_id,reply_id,scene_id,page,anchor_y_micros,scene_ids,target_profile_ids,actor_id,type,text,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", event.id, head.sequence + 1, event.cueId ?? null, event.discussionId ?? null, event.replyId ?? null, event.sceneId ?? null, event.page ?? null, micros(event.anchorY), event.sceneIds ? JSON.stringify(event.sceneIds) : null, event.targetProfileIds ? JSON.stringify(event.targetProfileIds) : null, event.actorId, event.type ?? "legacy", event.text, event.createdAt, ...guard.values));
  const beforeReads = new Set(before.state.inboxReads.map((item) => `${item.eventId}:${item.profileId}`));
  const afterReads = new Set(reduction.state.inboxReads.map((item) => `${item.eventId}:${item.profileId}`));
  for (const item of reduction.state.inboxReads.filter((entry) => !beforeReads.has(`${entry.eventId}:${entry.profileId}`))) statements.push(db.prepare(`INSERT INTO sync_inbox_reads (workspace_id,event_id,profile_id,read_at) SELECT ?,?,?,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", item.eventId, item.profileId, item.readAt, ...guard.values));
  for (const item of before.state.inboxReads.filter((entry) => !afterReads.has(`${entry.eventId}:${entry.profileId}`))) statements.push(db.prepare(`DELETE FROM sync_inbox_reads WHERE workspace_id=? AND event_id=? AND profile_id=? AND EXISTS (SELECT 1 FROM sync_head WHERE ${guard.sql})`).bind("lighting-design", item.eventId, item.profileId, ...guard.values));
  const beforePins = new Set(before.state.inboxPins.map((item) => `${item.eventId}:${item.profileId}`));
  const afterPins = new Set(reduction.state.inboxPins.map((item) => `${item.eventId}:${item.profileId}`));
  for (const item of reduction.state.inboxPins.filter((entry) => !beforePins.has(`${entry.eventId}:${entry.profileId}`))) statements.push(db.prepare(`INSERT INTO sync_inbox_pins (workspace_id,event_id,profile_id,pinned_at) SELECT ?,?,?,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", item.eventId, item.profileId, item.pinnedAt, ...guard.values));
  for (const item of before.state.inboxPins.filter((entry) => !afterPins.has(`${entry.eventId}:${entry.profileId}`))) statements.push(db.prepare(`DELETE FROM sync_inbox_pins WHERE workspace_id=? AND event_id=? AND profile_id=? AND EXISTS (SELECT 1 FROM sync_head WHERE ${guard.sql})`).bind("lighting-design", item.eventId, item.profileId, ...guard.values));
  return statements;
}

function targetPredicates(action: SyncAction, values: unknown[]) {
  const predicates: string[] = [];
  const cuePredicate = (cueId: string, field: string, expected: number | undefined, deleted?: boolean) => {
    if (expected === undefined) return;
    predicates.push(`EXISTS (SELECT 1 FROM sync_cues WHERE workspace_id = ? AND id = ? AND ${field} = ?${deleted === false ? " AND deleted_at IS NULL" : ""})`);
    values.push("lighting-design", cueId, expected);
  };
  if ("cueId" in action) {
    cuePredicate(action.cueId, "position_version", "expectedPositionVersion" in action ? action.expectedPositionVersion : undefined, false);
    cuePredicate(action.cueId, "lifecycle_version", "expectedLifecycleVersion" in action ? action.expectedLifecycleVersion : undefined);
    cuePredicate(action.cueId, "assignment_version", "expectedAssignmentVersion" in action ? action.expectedAssignmentVersion : undefined, false);
    cuePredicate(action.cueId, "blackout_version", "expectedBlackoutVersion" in action ? action.expectedBlackoutVersion : undefined, false);
  }
  if (action.type === "assignCueNumbers") {
    // D1 allows only 100 parameters per query. Keep all selected versions in
    // one parameter so the atomic guard also works for the full 500-cue limit.
    predicates.push(`NOT EXISTS (
      SELECT 1 FROM json_each(?) AS selected
      LEFT JOIN sync_cues AS cue ON cue.workspace_id = ? AND cue.id = json_extract(selected.value, '$.cueId')
      WHERE cue.id IS NULL OR cue.deleted_at IS NOT NULL
        OR cue.position_version IS NOT json_extract(selected.value, '$.expectedPositionVersion')
        OR cue.lifecycle_version IS NOT json_extract(selected.value, '$.expectedLifecycleVersion')
        OR cue.assignment_version IS NOT json_extract(selected.value, '$.expectedAssignmentVersion')
    )`);
    values.push(JSON.stringify(action.cues), "lighting-design");
  }
  if (action.type === "setSceneOwners") for (const scene of action.scenes) {
    predicates.push("EXISTS (SELECT 1 FROM sync_scenes WHERE workspace_id = ? AND id = ? AND version = ?)");
    values.push("lighting-design", scene.sceneId, scene.expectedVersion);
  }
  if (action.type === "setDiscussionResolved") {
    predicates.push("EXISTS (SELECT 1 FROM sync_discussions WHERE workspace_id = ? AND id = ? AND version = ?)");
    values.push("lighting-design", action.discussionId, action.expectedVersion);
  }
  return predicates;
}

async function commitTerminal(db: D1Database, envelope: OperationEnvelope, hash: string, head: SyncHead, reduction: StructuredReduction, projection: LoadedProjection, qaFault?: QaFault) {
  const attempt = crypto.randomUUID();
  const now = new Date().toISOString();
  const predicateValues: unknown[] = [];
  const predicates = isTextAction(envelope.action) || !["applied", "adjusted"].includes(reduction.status) ? [] : targetPredicates(envelope.action, predicateValues);
  const headSql = `UPDATE sync_head SET sequence=sequence+1,commit_token=?,updated_at=? WHERE workspace_id=? AND epoch=? AND sequence=? AND write_mode='enabled' AND NOT EXISTS (SELECT 1 FROM sync_receipts WHERE workspace_id=? AND operation_id=?)${predicates.map((item) => ` AND ${item}`).join("")}`;
  const statements: D1PreparedStatement[] = [db.prepare(headSql).bind(attempt, now, "lighting-design", head.epoch, head.sequence, "lighting-design", envelope.operationId, ...predicateValues)];
  statements.push(...appendStructuredEffectStatements(db, projection, reduction, head, attempt));
  const guard = guardSuffix(head.sequence, attempt); guard.values[1] = head.epoch;
  if (envelope.action.type === "createCue") {
    const cue = envelope.action.cue;
    const document = await createCanonicalTextDocument(cue);
    const documentChunks = await payloadChunks(document.encodedState);
    statements.push(
      db.prepare(`INSERT INTO sync_text_documents (workspace_id,cue_id,revision,workspace_sequence,state_vector,state_hash,chunk_count,encoded_bytes,update_count,update_bytes,updated_at) SELECT ?,?,0,sequence,?,?,?,?,0,0,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", cue.id, asArrayBuffer(document.stateVector), document.hash, documentChunks.length, document.encodedState.byteLength, now, ...guard.values),
      ...documentChunks.map((chunk, index) => db.prepare(`INSERT INTO sync_text_document_chunks (workspace_id,cue_id,revision,chunk_index,payload,payload_hash) SELECT ?,?,0,?,?,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", cue.id, index, asArrayBuffer(chunk.payload), chunk.hash, ...guard.values)),
      db.prepare(`INSERT INTO sync_text_checkpoints (workspace_id,cue_id,revision,sequence,state_vector,state_hash,chunk_count,encoded_bytes,created_at) SELECT ?,?,0,sequence,?,?,?,?,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", cue.id, asArrayBuffer(document.stateVector), document.hash, documentChunks.length, document.encodedState.byteLength, now, ...guard.values),
      ...documentChunks.map((chunk, index) => db.prepare(`INSERT INTO sync_text_checkpoint_chunks (workspace_id,cue_id,revision,chunk_index,payload,payload_hash) SELECT ?,?,0,?,?,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", cue.id, index, asArrayBuffer(chunk.payload), chunk.hash, ...guard.values)),
      db.prepare(`INSERT INTO sync_text_history (workspace_id,cue_id,revision,sequence,operation_id,title,description,technical_notes,actor_id,created_at) SELECT ?,?,0,sequence,?,?,?,?,?,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", cue.id, envelope.operationId, document.title, document.description, document.technicalNotes, envelope.actorId, now, ...guard.values),
    );
  }
  if (envelope.action.type === "acknowledgeNotice" && reduction.status === "applied") {
    statements.push(db.prepare(`UPDATE sync_notices SET acknowledged_at=? WHERE workspace_id=? AND id=? AND acknowledged_at IS NULL AND EXISTS (SELECT 1 FROM sync_head WHERE ${guard.sql})`).bind(now, "lighting-design", envelope.action.noticeId, ...guard.values));
  }
  if (operationNeedsAttention(reduction)) {
    statements.push(db.prepare(`INSERT INTO sync_notices (workspace_id,id,operation_id,profile_id,code,payload,created_at,acknowledged_at) SELECT ?,?,?,?,?,?,?,NULL FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", `notice-${envelope.operationId}`.slice(0, 200), envelope.operationId, envelope.actorId, reduction.code ?? reduction.status, stableJson({ status: reduction.status, message: reduction.message, outcome: reduction.outcome }), now, ...guard.values));
  }
  const outcome = stableJson(reduction.outcome);
  const trailerStart = statements.length;
  statements.push(
    db.prepare(`INSERT INTO sync_operations (workspace_id,operation_id,request_hash,kind,actor_id,session_id,target_id,sequence,metadata,payload_bytes,accepted_at) SELECT ?,?,?,?,?,?,?,sequence,?,?,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", envelope.operationId, hash, envelope.action.type, envelope.actorId, envelope.sessionId, actionTargetId(envelope.action) ?? null, stableJson(envelope), new TextEncoder().encode(stableJson(envelope)).byteLength, now, ...guard.values),
    db.prepare(`INSERT INTO sync_receipts (workspace_id,operation_id,request_hash,status,sequence,code,message,outcome,created_at) SELECT ?,?,?,?,sequence,?,?,?,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", envelope.operationId, hash, reduction.status, reduction.code ?? null, reduction.message ?? null, outcome, now, ...guard.values),
    db.prepare(`INSERT INTO sync_events (workspace_id,sequence,operation_id,kind,target_id,summary,created_at) SELECT ?,sequence,?,?,?,?,? FROM sync_head WHERE ${guard.sql}`).bind("lighting-design", envelope.operationId, envelope.action.type, actionTargetId(envelope.action) ?? null, outcome, now, ...guard.values),
  );
  const results = await db.batch(withQaFault(db, statements, trailerStart, qaFault));
  if (changedRows(results[0]) !== 1) return false;
  requireSingleRowEffects(results);
  return true;
}

async function commitText(db: D1Database, envelope: OperationEnvelope, hash: string, head: SyncHead, overrideAction?: Extract<SyncAction, { type: "applyTextUpdate" }>, qaFault?: QaFault) {
  const action = overrideAction ?? (isTextAction(envelope.action) ? envelope.action : null);
  if (!action) throw new Error("Expected a text action.");
  const [row, cueRow] = await Promise.all([
    readCanonicalTextDocument(db, action.cueId),
    db.prepare("SELECT deleted_at FROM sync_cues WHERE workspace_id=? AND id=?").bind("lighting-design", action.cueId).first<{ deleted_at: string | null }>(),
  ]);
  if (!row || !cueRow) return terminalResult(head, envelope, "not_applied", "target_missing", "The cue text document is unavailable.");
  if (action.expectedDocumentRevision !== undefined && action.expectedDocumentRevision !== row.revision) {
    return terminalResult(head, envelope, "not_applied", "repair_preview_stale", "The cue changed while its saved text was being repaired. Review the latest text before trying again.", { cueId: action.cueId, currentRevision: row.revision });
  }
  const decoded = decodeTextAction(action);
  const validation = await validateAndApplyTextUpdate({ encodedState: row.encodedState, revision: row.revision, baseDocumentRevision: action.baseDocumentRevision, ...decoded });
  if (!validation.ok) return terminalResult(head, envelope, validation.code === "dependency_pending" ? "dependency_pending" : validation.code === "stale_document" ? "not_applied" : "invalid", validation.code, validation.message, validation.details);
  if (validation.document.encodedState.byteLength > MAX_CANONICAL_TEXT_BYTES) return terminalResult(head, envelope, "not_applied", "target_capacity", "This cue's saved text history exceeds the measured safe processing limit.", { cueId: action.cueId, encodedBytes: validation.document.encodedState.byteLength, maximumBytes: MAX_CANONICAL_TEXT_BYTES });
  const attempt = crypto.randomUUID();
  const now = new Date().toISOString();
  const actionBytes = decoded.update;
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < actionBytes.byteLength; offset += MAX_SYNC_PAYLOAD_CHUNK_BYTES) chunks.push(actionBytes.subarray(offset, offset + MAX_SYNC_PAYLOAD_CHUNK_BYTES));
  const chunkHashes = await Promise.all(chunks.map(sha256));
  const documentChunks = await payloadChunks(validation.document.encodedState);
  const nextRevision = row.revision + 1;
  const checkpoint = row.update_count + 1 >= 100 || row.update_bytes + actionBytes.byteLength >= 256 * 1024;
  const guardSql = "workspace_id=? AND epoch=? AND sequence=? AND commit_token=?";
  const guardValues = ["lighting-design", head.epoch, head.sequence + 1, attempt];
  const headStatement = db.prepare("UPDATE sync_head SET sequence=sequence+1,commit_token=?,updated_at=? WHERE workspace_id=? AND epoch=? AND sequence=? AND write_mode='enabled' AND NOT EXISTS (SELECT 1 FROM sync_receipts WHERE workspace_id=? AND operation_id=?) AND EXISTS (SELECT 1 FROM sync_cues WHERE workspace_id=? AND id=?) AND EXISTS (SELECT 1 FROM sync_text_documents WHERE workspace_id=? AND cue_id=? AND revision=?)")
    .bind(attempt, now, "lighting-design", head.epoch, head.sequence, "lighting-design", envelope.operationId, "lighting-design", action.cueId, "lighting-design", action.cueId, row.revision);
  const savedToDeletedCue = !!cueRow.deleted_at;
  const status = savedToDeletedCue ? "adjusted" : "applied";
  const code = savedToDeletedCue ? "saved_to_deleted_cue" : undefined;
  const message = savedToDeletedCue ? "The text was saved with its cue in Recently deleted." : undefined;
  const outcome = { cueId: action.cueId, documentRevision: nextRevision, stateHash: validation.document.hash, savedToDeletedCue, ...(envelope.action.type === "restoreTextVersion" ? { restoredFromRevision: envelope.action.historyRevision } : {}) };
  const statements: D1PreparedStatement[] = [headStatement,
    db.prepare(`DELETE FROM sync_text_document_chunks WHERE workspace_id=? AND cue_id=? AND EXISTS (SELECT 1 FROM sync_head WHERE ${guardSql})`).bind("lighting-design", action.cueId, ...guardValues),
    db.prepare(`UPDATE sync_text_documents SET revision=?,workspace_sequence=?,state_vector=?,state_hash=?,chunk_count=?,encoded_bytes=?,update_count=?,update_bytes=?,updated_at=? WHERE workspace_id=? AND cue_id=? AND EXISTS (SELECT 1 FROM sync_head WHERE ${guardSql})`).bind(nextRevision, head.sequence + 1, asArrayBuffer(validation.document.stateVector), validation.document.hash, documentChunks.length, validation.document.encodedState.byteLength, checkpoint ? 0 : row.update_count + 1, checkpoint ? 0 : row.update_bytes + actionBytes.byteLength, now, "lighting-design", action.cueId, ...guardValues),
    ...documentChunks.map((chunk, index) => db.prepare(`INSERT INTO sync_text_document_chunks (workspace_id,cue_id,revision,chunk_index,payload,payload_hash) SELECT ?,?,?,?, ?,? FROM sync_head WHERE ${guardSql}`).bind("lighting-design", action.cueId, nextRevision, index, asArrayBuffer(chunk.payload), chunk.hash, ...guardValues)),
    db.prepare(`UPDATE sync_cues SET text_revision=?,title=?,description=?,technical_notes=? WHERE workspace_id=? AND id=? AND EXISTS (SELECT 1 FROM sync_head WHERE ${guardSql})`).bind(nextRevision, validation.document.title, validation.document.description, validation.document.technicalNotes, "lighting-design", action.cueId, ...guardValues),
    ...chunks.map((chunk, index) => db.prepare(`INSERT INTO sync_payload_chunks (workspace_id,operation_id,chunk_index,payload,payload_hash) SELECT ?,?,?,?,? FROM sync_head WHERE ${guardSql}`).bind("lighting-design", envelope.operationId, index, asArrayBuffer(chunk), chunkHashes[index], ...guardValues)),
    db.prepare(`INSERT INTO sync_text_history (workspace_id,cue_id,revision,sequence,operation_id,title,description,technical_notes,actor_id,created_at) SELECT ?,?,?,sequence,?,?,?,?,?,? FROM sync_head WHERE ${guardSql}`).bind("lighting-design", action.cueId, nextRevision, envelope.operationId, validation.document.title, validation.document.description, validation.document.technicalNotes, envelope.actorId, now, ...guardValues),
    db.prepare(`INSERT INTO sync_operations (workspace_id,operation_id,request_hash,kind,actor_id,session_id,target_id,sequence,metadata,payload_bytes,accepted_at) SELECT ?,?,?,?,?,?,?,sequence,?,?,? FROM sync_head WHERE ${guardSql}`).bind("lighting-design", envelope.operationId, hash, envelope.action.type, envelope.actorId, envelope.sessionId, action.cueId, stableJson(isTextAction(envelope.action) ? { ...envelope, action: { ...envelope.action, update: undefined } } : envelope), actionBytes.byteLength, now, ...guardValues),
    db.prepare(`INSERT INTO sync_receipts (workspace_id,operation_id,request_hash,status,sequence,code,message,outcome,created_at) SELECT ?,?,?,?,sequence,?,?,?,? FROM sync_head WHERE ${guardSql}`).bind("lighting-design", envelope.operationId, hash, status, code ?? null, message ?? null, stableJson(outcome), now, ...guardValues),
    db.prepare(`INSERT INTO sync_events (workspace_id,sequence,operation_id,kind,target_id,summary,created_at) SELECT ?,sequence,?,?,?,?,? FROM sync_head WHERE ${guardSql}`).bind("lighting-design", envelope.operationId, envelope.action.type, action.cueId, stableJson(outcome), now, ...guardValues),
  ];
  const trailerStart = statements.length - 3;
  if (checkpoint) statements.push(
    db.prepare(`INSERT INTO sync_text_checkpoints (workspace_id,cue_id,revision,sequence,state_vector,state_hash,chunk_count,encoded_bytes,created_at) SELECT ?,?,?,sequence,?,?,?,?,? FROM sync_head WHERE ${guardSql}`).bind("lighting-design", action.cueId, nextRevision, asArrayBuffer(validation.document.stateVector), validation.document.hash, documentChunks.length, validation.document.encodedState.byteLength, now, ...guardValues),
    ...documentChunks.map((chunk, index) => db.prepare(`INSERT INTO sync_text_checkpoint_chunks (workspace_id,cue_id,revision,chunk_index,payload,payload_hash) SELECT ?,?,?,?,?,? FROM sync_head WHERE ${guardSql}`).bind("lighting-design", action.cueId, nextRevision, index, asArrayBuffer(chunk.payload), chunk.hash, ...guardValues)),
  );
  let results: D1Result<unknown>[];
  try { results = await db.batch(withQaFault(db, statements, trailerStart, qaFault, 2)); } catch { return terminalResult(head, envelope, "retry_later", "commit_failed", "The text change could not be committed yet.", { retryAfterMs: 500 }); }
  if (changedRows(results[0]) !== 1) return null;
  if (changedRows(results[1]) !== row.chunk_count) throw new CommitInvariantError("Sync text commit removed an unexpected number of document chunks.");
  requireSingleRowEffects(results, 2);
  return { protocol: SYNC_PROTOCOL, workspaceId: envelope.workspaceId, epoch: head.epoch, operationId: envelope.operationId, status, sequence: head.sequence + 1, code, message, outcome } satisfies OperationResult;
}

export async function processOperation(db: D1Database, envelope: OperationEnvelope, qaFault?: QaFault): Promise<OperationResult> {
  const hash = await operationHash(envelope);
  let commitFailed = false;
  // Five simultaneous editors can consume four sequence-CAS attempts even
  // when their cue fields are independent. Keep retries bounded but allow
  // the fifth writer to settle without another network/retry cycle.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // One consistent D1 batch replaces three sequential read round trips.
    const [headResult, receiptResultRows, actorResult] = await db.batch([
      db.prepare("SELECT * FROM sync_head WHERE workspace_id = ?").bind("lighting-design"),
      db.prepare("SELECT request_hash,status,sequence,code,message,outcome,created_at FROM sync_receipts WHERE workspace_id=? AND operation_id=?").bind("lighting-design", envelope.operationId),
      db.prepare("SELECT 1 AS present FROM sync_profiles WHERE workspace_id=? AND id=?").bind("lighting-design", envelope.actorId),
    ]);
    const head = rows<SyncHead>(headResult)[0];
    if (!head) return { protocol: SYNC_PROTOCOL, workspaceId: envelope.workspaceId, epoch: envelope.epoch, operationId: envelope.operationId, status: "retry_later", code: "migration_required", message: "Sync v2 has not been prepared for this workspace.", retryAfterMs: 2_000 };
    const receipt = rows<NonNullable<Awaited<ReturnType<typeof readReceipt>>>>(receiptResultRows)[0];
    if (receipt) {
      if (receipt.request_hash !== hash) return terminalResult(head, envelope, "invalid", "operation_id_reused", "This operation ID was reused with different content.");
      return receiptResult(head, envelope, receipt);
    }
    if (head.epoch !== envelope.epoch || envelope.workspaceId !== head.workspace_id || envelope.protocol < head.protocol_min || envelope.protocol > head.protocol_max) return terminalResult(head, envelope, "invalid", "protocol_mismatch", "Refresh this workspace before saving more changes.");
    if (head.write_mode !== "enabled") return terminalResult(head, envelope, "retry_later", "writes_disabled", "Editing is temporarily unavailable.", { retryAfterMs: 2_000 });
    const actor = rows<{ present: number }>(actorResult)[0];
    if (!actor) return terminalResult(head, envelope, "invalid", "unknown_actor", "Choose an existing profile before saving this change.");
    const attributedActor = envelope.action.type === "addNote" ? envelope.action.discussion.authorId : envelope.action.type === "addReply" ? envelope.action.reply.authorId : envelope.action.type === "setInboxRead" || envelope.action.type === "setInboxPinned" || envelope.action.type === "acknowledgeNotice" ? envelope.action.profileId : envelope.actorId;
    if (attributedActor !== envelope.actorId) return terminalResult(head, envelope, "invalid", "actor_mismatch", "The selected profile does not match this change's attribution.");
    const dependency = await missingDependency(db, envelope.dependsOn);
    if (dependency) return terminalResult(head, envelope, "dependency_pending", "dependency_pending", "An earlier change must settle first.", { dependency });
    if (isTextAction(envelope.action)) {
      const textResult = await commitText(db, envelope, hash, head, undefined, qaFault);
      if (textResult) return textResult;
      continue;
    }
    if (envelope.action.type === "restoreTextVersion") {
      const [document, historical] = await Promise.all([
        readCanonicalTextDocument(db, envelope.action.cueId),
        db.prepare("SELECT title,description,technical_notes FROM sync_text_history WHERE workspace_id=? AND cue_id=? AND revision=?").bind("lighting-design", envelope.action.cueId, envelope.action.historyRevision).first<{ title: string; description: string; technical_notes: string }>(),
      ]);
      if (!document || !historical) return terminalResult(head, envelope, "not_applied", "history_missing", "That saved text version is unavailable.");
      if (document.revision !== envelope.action.expectedDocumentRevision) {
        const projection = await loadSyncProjection(db, envelope.action);
        const reduction: StructuredReduction = { status: "not_applied", state: projection.state, code: "restore_preview_stale", message: "The cue changed while the restore preview was open. Refresh the preview and choose Restore again.", outcome: { cueId: envelope.action.cueId, currentRevision: document.revision }, bumps: {} };
        if (await commitTerminal(db, envelope, hash, head, reduction, projection, qaFault)) return { ...terminalResult(head, envelope, reduction.status, reduction.code, reduction.message, reduction.outcome), sequence: head.sequence + 1 };
        continue;
      }
      const replacement = createTextReplacementUpdate(document.encodedState, { title: historical.title, description: historical.description, technicalNotes: historical.technical_notes });
      const textResult = await commitText(db, envelope, hash, head, { type: "applyTextUpdate", cueId: envelope.action.cueId, baseDocumentRevision: document.revision, baseStateVector: bytesToBase64(replacement.baseStateVector), resultStateVector: bytesToBase64(replacement.resultStateVector), update: bytesToBase64(replacement.update) }, qaFault);
      if (textResult) return textResult;
      continue;
    }
    if (envelope.action.type === "acknowledgeNotice") {
      const [projection, notice] = await Promise.all([
        loadSyncProjection(db, envelope.action),
        db.prepare("SELECT profile_id,acknowledged_at FROM sync_notices WHERE workspace_id=? AND id=?").bind("lighting-design", envelope.action.noticeId).first<{ profile_id: string | null; acknowledged_at: string | null }>(),
      ]);
      const allowed = notice && (!notice.profile_id || notice.profile_id === envelope.action.profileId);
      const reduction: StructuredReduction = allowed
        ? { status: notice.acknowledged_at ? "unchanged" : "applied", state: projection.state, outcome: { noticeId: envelope.action.noticeId }, bumps: {} }
        : { status: "not_applied", state: projection.state, code: "notice_missing", message: "That notice is unavailable.", outcome: { noticeId: envelope.action.noticeId }, bumps: {} };
      if (await commitTerminal(db, envelope, hash, head, reduction, projection, qaFault)) return { ...terminalResult(head, envelope, reduction.status, reduction.code, reduction.message, reduction.outcome), sequence: head.sequence + 1 };
      continue;
    }
    const projection = await loadSyncProjection(db, envelope.action);
    const reduction = reduceStructuredAction(projection.state, projection.versions, envelope.action, { actorId: envelope.actorId, operationId: envelope.operationId, createdAt: new Date().toISOString() });
    if (["dependency_pending", "retry_later"].includes(reduction.status)) return terminalResult(head, envelope, reduction.status, reduction.code, reduction.message, reduction.outcome);
    try {
      if (await commitTerminal(db, envelope, hash, head, reduction, projection, qaFault)) return { protocol: SYNC_PROTOCOL, workspaceId: envelope.workspaceId, epoch: head.epoch, operationId: envelope.operationId, status: reduction.status, sequence: head.sequence + 1, code: reduction.code, message: reduction.message, outcome: reduction.outcome };
    } catch (error) {
      if (error instanceof CommitInvariantError) throw error;
      const racedReceipt = await readReceipt(db, envelope.operationId);
      if (racedReceipt) return racedReceipt.request_hash === hash ? receiptResult(head, envelope, racedReceipt) : terminalResult(head, envelope, "invalid", "operation_id_reused", "This operation ID was reused with different content.");
      const message = error instanceof Error ? error.message : String(error);
      if (/too many SQL variables|statement too long|SQLITE_TOOBIG|expression tree is too large/i.test(message)) {
        const rejected: StructuredReduction = { status: "not_applied", state: projection.state, code: "query_limit", message: "This save exceeded a database limit. No changes were applied. The request was kept for review.", outcome: {}, bumps: {} };
        // Record the rejection without the oversized target guard, so retries
        // receive the same receipt and the browser can preserve it in Recovery.
        if (await commitTerminal(db, envelope, hash, head, rejected, projection)) return { ...terminalResult(head, envelope, rejected.status, rejected.code, rejected.message), sequence: head.sequence + 1 };
      }
      commitFailed = true;
    }
  }
  const head = await readSyncHead(db);
  return { protocol: SYNC_PROTOCOL, workspaceId: envelope.workspaceId, epoch: head?.epoch ?? envelope.epoch, operationId: envelope.operationId, status: "retry_later", code: commitFailed ? "commit_failed" : "contention", message: commitFailed ? "The database could not save this change yet. The request was kept and will retry." : "The workspace is busy. Retry this same operation shortly.", retryAfterMs: 500 };
}
