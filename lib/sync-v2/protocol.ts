import type { Cue, Discussion, Profile } from "../types.ts";

export const SYNC_PROTOCOL = 2 as const;
export const SYNC_WORKSPACE_ID = "lighting-design";
export const MAX_SYNC_REQUEST_BYTES = 1_000_000;
export const MAX_SYNC_BATCH = 20;
export const MAX_SYNC_PAYLOAD_CHUNK_BYTES = 256 * 1024;

export type OperationStatus =
  | "applied"
  | "adjusted"
  | "unchanged"
  | "not_applied"
  | "dependency_pending"
  | "retry_later"
  | "invalid";

export type ExpectedCueVersions = {
  expectedAssignmentVersion?: number;
  expectedBlackoutVersion?: number;
  expectedLifecycleVersion?: number;
  expectedPositionVersion?: number;
};

export type SyncAction =
  | { type: "applyTextUpdate"; cueId: string; baseDocumentRevision: number; baseStateVector: string; resultStateVector: string; update: string; expectedDocumentRevision?: number }
  | { type: "createCue"; cue: Cue; assignNumber?: boolean }
  | ({ type: "assignNextNumber"; cueId: string } & ExpectedCueVersions)
  | { type: "assignCueNumbers"; cues: Array<{ cueId: string; expectedAssignmentVersion: number; expectedLifecycleVersion: number; expectedPositionVersion: number }> }
  | ({ type: "setCueNumber"; cueId: string; number: number | string } & ExpectedCueVersions)
  | ({ type: "unassignCue"; cueId: string } & ExpectedCueVersions)
  | ({ type: "setCueMode"; cueId: string; mode: Cue["mode"] } & ExpectedCueVersions)
  | { type: "setBlackout"; cueId: string; blackout: boolean; expectedBlackoutVersion: number }
  | ({ type: "moveCue"; cueId: string; position: Pick<Cue, "sceneId" | "page" | "anchorType" | "selectedText" | "enclosingLine" | "anchorX" | "anchorY" | "anchorOrder"> } & ExpectedCueVersions)
  | { type: "setSceneOwners"; scenes: Array<{ sceneId: string; ownerId: string | null; expectedVersion: number }> }
  | { type: "createOrUpdateProfile"; profile: Profile; expectedVersion?: number }
  | { type: "addNote"; discussion: Discussion }
  | { type: "addReply"; discussionId: string; reply: Discussion["replies"][number] }
  | { type: "setDiscussionResolved"; discussionId: string; resolved: boolean; expectedVersion: number }
  | { type: "setInboxRead"; eventIds: string[]; profileId: string; read: boolean }
  | { type: "setInboxPinned"; eventIds: string[]; profileId: string; pinned: boolean }
  | ({ type: "deleteCue"; cueId: string } & ExpectedCueVersions)
  | ({ type: "restoreCue"; cueId: string } & ExpectedCueVersions)
  | { type: "restoreTextVersion"; cueId: string; historyRevision: number; expectedDocumentRevision: number }
  | { type: "acknowledgeNotice"; noticeId: string; profileId: string };

export type OperationEnvelope = {
  protocol: typeof SYNC_PROTOCOL;
  workspaceId: string;
  epoch: string;
  operationId: string;
  sessionId: string;
  actorId: string;
  createdAt: string;
  dependsOn: string[];
  action: SyncAction;
};

export type OperationResult = {
  protocol: typeof SYNC_PROTOCOL;
  workspaceId: string;
  epoch: string;
  operationId: string;
  status: OperationStatus;
  sequence?: number;
  code?: string;
  message?: string;
  outcome?: Record<string, unknown>;
  retryAfterMs?: number;
};

export type SyncEvent = {
  protocol: typeof SYNC_PROTOCOL;
  epoch: string;
  sequence: number;
  operationId: string;
  kind: SyncAction["type"];
  targetId?: string;
  summary: Record<string, unknown>;
  createdAt: string;
};

export type SyncNoticeRecord = {
  id: string;
  operationId?: string;
  profileId?: string;
  targetId?: string;
  code: string;
  status?: OperationStatus;
  message?: string;
  outcome: Record<string, unknown>;
  createdAt: string;
};

export type ConnectionState =
  | "starting"
  | "checking"
  | "recovering"
  | "online"
  | "uncertain"
  | "offline"
  | "storage_blocked"
  | "target_blocked"
  | "upgrade_required"
  | "maintenance";

export type SaveState = "idle" | "local" | "sending" | "saved" | "needs_attention";

export function actionTargetId(action: SyncAction) {
  if ("cueId" in action) return action.cueId;
  if (action.type === "addNote") return action.discussion.cueId ?? action.discussion.sceneId;
  if (action.type === "addReply" || action.type === "setDiscussionResolved") return action.discussionId;
  if (action.type === "createCue") return action.cue.id;
  if (action.type === "createOrUpdateProfile") return action.profile.id;
  if (action.type === "acknowledgeNotice") return action.noticeId;
  return undefined;
}

export function isTextAction(action: SyncAction): action is Extract<SyncAction, { type: "applyTextUpdate" }> {
  return action.type === "applyTextUpdate";
}
