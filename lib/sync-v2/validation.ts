import { parseCueNumber } from "../cue-numbering.ts";
import { FIELD_LIMITS } from "../field-limits.ts";
import { MAX_SYNC_BATCH, SYNC_PROTOCOL, SYNC_WORKSPACE_ID, type OperationEnvelope, type SyncAction } from "./protocol.ts";

const actionTypes = new Set<SyncAction["type"]>([
  "applyTextUpdate", "createCue", "assignNextNumber", "assignCueNumbers", "setCueNumber", "unassignCue", "setCueMode", "setBlackout", "moveCue",
  "setSceneOwners", "createOrUpdateProfile", "addNote", "addReply", "setDiscussionResolved", "setInboxRead", "setInboxPinned", "deleteCue", "restoreCue",
  "restoreTextVersion", "acknowledgeNotice",
]);

export function safeSyncId(value: unknown, maximum = 200): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && /^[A-Za-z0-9:_-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, maximum: number, allowEmpty = true) {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.trim().length > 0);
}

function version(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

function date(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function idList(value: unknown, maximum = 500) {
  return Array.isArray(value) && value.length <= maximum && value.every((id) => safeSyncId(id)) && new Set(value).size === value.length;
}

function cueShape(value: unknown) {
  if (!isRecord(value)) return false;
  return safeSyncId(value.id)
    && (value.number === null || parseCueNumber(value.number) !== null)
    && text(value.title, FIELD_LIMITS.cueTitle)
    && text(value.description, FIELD_LIMITS.cueDescription)
    && text(value.technicalNotes, FIELD_LIMITS.technicalNotes)
    && ["unassigned", "planned", "implemented"].includes(String(value.mode))
    && typeof value.blackout === "boolean"
    && safeSyncId(value.sceneId)
    && Number.isSafeInteger(value.page) && Number(value.page) >= 1
    && ["line", "phrase"].includes(String(value.anchorType))
    && text(value.selectedText, FIELD_LIMITS.note)
    && text(value.enclosingLine, FIELD_LIMITS.note)
    && (value.anchorX === undefined || finite(value.anchorX))
    && (value.anchorY === undefined || finite(value.anchorY))
    && finite(value.anchorOrder)
    && (value.ownerId === undefined || safeSyncId(value.ownerId));
}

function profileShape(value: unknown) {
  if (!isRecord(value)) return false;
  return safeSyncId(value.id) && text(value.name, FIELD_LIMITS.profileName, false) && text(value.role, FIELD_LIMITS.profileRole, false)
    && text(value.initials, FIELD_LIMITS.profileInitials, false) && typeof value.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color);
}

function replyShape(value: unknown) {
  if (!isRecord(value)) return false;
  return safeSyncId(value.id) && safeSyncId(value.authorId) && text(value.content, FIELD_LIMITS.reply, false) && date(value.createdAt);
}

function discussionShape(value: unknown) {
  if (!isRecord(value)) return false;
  return safeSyncId(value.id) && ["cue", "scene", "script"].includes(String(value.targetType))
    && (value.cueId === undefined || safeSyncId(value.cueId)) && (value.sceneId === undefined || safeSyncId(value.sceneId))
    && (value.page === undefined || Number.isSafeInteger(value.page) && Number(value.page) >= 1)
    && (value.anchorX === undefined || finite(value.anchorX)) && (value.anchorY === undefined || finite(value.anchorY))
    && (value.selectedText === undefined || text(value.selectedText, FIELD_LIMITS.note))
    && (value.enclosingLine === undefined || text(value.enclosingLine, FIELD_LIMITS.note))
    && safeSyncId(value.authorId) && text(value.content, FIELD_LIMITS.note, false) && date(value.createdAt)
    && typeof value.resolved === "boolean" && (value.resolvedBy === undefined || safeSyncId(value.resolvedBy))
    && Array.isArray(value.replies) && value.replies.length === 0;
}

function cueId(action: Record<string, unknown>) {
  return safeSyncId(action.cueId);
}

function validAction(action: Record<string, unknown>) {
  if (typeof action.type !== "string" || !actionTypes.has(action.type as SyncAction["type"])) return false;
  if (action.type === "applyTextUpdate") return cueId(action) && version(action.baseDocumentRevision)
    && (action.expectedDocumentRevision === undefined || version(action.expectedDocumentRevision))
    && [action.baseStateVector, action.resultStateVector, action.update].every((item) => typeof item === "string" && item.length <= 1_400_000);
  if (action.type === "createCue") return cueShape(action.cue) && (action.assignNumber === undefined || typeof action.assignNumber === "boolean");
  if (action.type === "assignNextNumber") return cueId(action) && version(action.expectedAssignmentVersion) && version(action.expectedLifecycleVersion) && version(action.expectedPositionVersion);
  if (action.type === "assignCueNumbers") return Array.isArray(action.cues) && action.cues.length >= 1 && action.cues.length <= 500 && action.cues.every((item) => isRecord(item) && cueId(item) && version(item.expectedAssignmentVersion) && version(item.expectedLifecycleVersion) && version(item.expectedPositionVersion));
  if (action.type === "setCueNumber") return cueId(action) && parseCueNumber(action.number) !== null && version(action.expectedAssignmentVersion);
  if (action.type === "unassignCue") return cueId(action) && version(action.expectedAssignmentVersion);
  if (action.type === "setCueMode") return cueId(action) && ["unassigned", "planned", "implemented"].includes(String(action.mode)) && version(action.expectedAssignmentVersion);
  if (action.type === "setBlackout") return cueId(action) && typeof action.blackout === "boolean" && version(action.expectedBlackoutVersion);
  if (action.type === "moveCue") return cueId(action) && isRecord(action.position) && safeSyncId(action.position.sceneId)
    && Number.isSafeInteger(action.position.page) && Number(action.position.page) >= 1 && ["line", "phrase"].includes(String(action.position.anchorType))
    && text(action.position.selectedText, FIELD_LIMITS.note) && text(action.position.enclosingLine, FIELD_LIMITS.note)
    && (action.position.anchorX === undefined || finite(action.position.anchorX)) && (action.position.anchorY === undefined || finite(action.position.anchorY))
    && finite(action.position.anchorOrder) && version(action.expectedPositionVersion) && version(action.expectedAssignmentVersion);
  if (action.type === "setSceneOwners") return Array.isArray(action.scenes) && action.scenes.length >= 1 && action.scenes.length <= 500 && action.scenes.every((item) => isRecord(item) && safeSyncId(item.sceneId) && (item.ownerId === null || safeSyncId(item.ownerId)) && version(item.expectedVersion));
  if (action.type === "createOrUpdateProfile") return profileShape(action.profile) && (action.expectedVersion === undefined || version(action.expectedVersion));
  if (action.type === "addNote") return discussionShape(action.discussion);
  if (action.type === "addReply") return safeSyncId(action.discussionId) && replyShape(action.reply);
  if (action.type === "setDiscussionResolved") return safeSyncId(action.discussionId) && typeof action.resolved === "boolean" && version(action.expectedVersion);
  if (action.type === "setInboxRead" || action.type === "setInboxPinned") return idList(action.eventIds) && safeSyncId(action.profileId) && typeof (action.type === "setInboxRead" ? action.read : action.pinned) === "boolean";
  if (action.type === "deleteCue" || action.type === "restoreCue") return cueId(action) && version(action.expectedLifecycleVersion);
  if (action.type === "restoreTextVersion") return cueId(action) && version(action.historyRevision) && version(action.expectedDocumentRevision);
  if (action.type === "acknowledgeNotice") return safeSyncId(action.noticeId) && safeSyncId(action.profileId);
  return false;
}

export function validEnvelope(value: unknown): value is OperationEnvelope {
  if (!isRecord(value) || value.protocol !== SYNC_PROTOCOL || value.workspaceId !== SYNC_WORKSPACE_ID) return false;
  if (!safeSyncId(value.epoch) || !safeSyncId(value.operationId, 128) || !safeSyncId(value.sessionId, 128) || !safeSyncId(value.actorId)) return false;
  if (!date(value.createdAt)) return false;
  if (!Array.isArray(value.dependsOn) || value.dependsOn.length > MAX_SYNC_BATCH || !value.dependsOn.every((id) => safeSyncId(id, 128)) || new Set(value.dependsOn).size !== value.dependsOn.length) return false;
  return isRecord(value.action) && validAction(value.action);
}

export function validOperationBatch(value: unknown): value is OperationEnvelope[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_SYNC_BATCH && value.every(validEnvelope);
}
