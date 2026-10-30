import { cleanCueAnchor } from "./anchor-text.ts";
import { readCueNumber, repairDuplicateCueNumbers } from "./cue-numbering.ts";
import { defaultState } from "./default-state.ts";
import type { HistoryEvent, Scene, WorkspaceConflictRecord, WorkspaceState } from "./types.ts";

function normalizeScenes(scenes: Scene[]) {
  const defaults = new Map(defaultState.scenes.map((scene) => [scene.id, scene]));
  return scenes.map((scene) => ({ ...scene, startY: scene.startY ?? defaults.get(scene.id)?.startY ?? 0 }));
}

export function normalizeWorkspaceState(saved: WorkspaceState): WorkspaceState {
  const savedSchemaVersion = saved.schemaVersion ?? 0;
  const document = saved.document?.pages === defaultState.document.pages ? saved.document : defaultState.document;
  const cues = repairDuplicateCueNumbers((saved.cues ?? []).map((cue) => cleanCueAnchor({
    ...cue,
    number: readCueNumber(cue.number),
    mode: cue.number ? cue.mode === "implemented" ? "implemented" : "planned" : "unassigned",
    blackout: cue.blackout ?? false,
    ...(savedSchemaVersion < 11 && cue.id === "cue-2" && cue.selectedText === "the day I got expelled" ? {
      selectedText: "saying goodbye to you",
      enclosingLine: "Because the truth might mean saying goodbye to you. For good.",
    } : {}),
  })));
  const cueScenes = new Map(cues.map((cue) => [cue.id, cue.sceneId]));
  const discussions = (saved.discussions ?? []).map((discussion) => {
    const normalized = {
      ...discussion,
      targetType: discussion.targetType ?? (discussion.cueId ? "cue" : discussion.sceneId ? "scene" : "script"),
      sceneId: discussion.sceneId ?? (discussion.cueId ? cueScenes.get(discussion.cueId) : undefined),
      replies: Array.isArray(discussion.replies) ? discussion.replies : [],
      resolved: discussion.resolved ?? false,
    };
    delete normalized.kind;
    return normalized;
  });
  const history: HistoryEvent[] = (saved.history ?? []).map((event) => {
    if (event.type) return { ...event, sceneId: event.sceneId ?? (event.cueId ? cueScenes.get(event.cueId) : undefined) };
    const closeInTime = (value: string) => Math.abs(new Date(value).getTime() - new Date(event.createdAt).getTime()) <= 1000;
    const matchingDiscussion = /added a (note|question)/i.test(event.text) ? discussions.find((discussion) => discussion.cueId === event.cueId && closeInTime(discussion.createdAt) && discussion.authorId === event.actorId) : undefined;
    const matchingReplyDiscussion = /replied to a (note|question)/i.test(event.text) ? discussions.find((discussion) => discussion.cueId === event.cueId && discussion.replies.some((reply) => closeInTime(reply.createdAt) && reply.authorId === event.actorId)) : undefined;
    if (matchingReplyDiscussion) return { ...event, discussionId: matchingReplyDiscussion.id, replyId: matchingReplyDiscussion.replies.find((reply) => closeInTime(reply.createdAt) && reply.authorId === event.actorId)?.id, sceneId: matchingReplyDiscussion.sceneId ?? (matchingReplyDiscussion.cueId ? cueScenes.get(matchingReplyDiscussion.cueId) : undefined), targetProfileIds: [matchingReplyDiscussion.authorId], type: "reply_added" };
    if (matchingDiscussion) return { ...event, discussionId: matchingDiscussion.id, sceneId: matchingDiscussion.sceneId ?? (matchingDiscussion.cueId ? cueScenes.get(matchingDiscussion.cueId) : undefined), type: "note_added" };
    return { ...event, type: "legacy", sceneId: event.sceneId ?? (event.cueId ? cueScenes.get(event.cueId) : undefined) };
  });
  const migratedDiscussionHistory: HistoryEvent[] = savedSchemaVersion < 11 ? discussions.flatMap((discussion) => {
    const events: HistoryEvent[] = [];
    if (!history.some((event) => event.discussionId === discussion.id && event.type === "note_added")) {
      events.push({ id: `migrated-${discussion.id}`, cueId: discussion.cueId, discussionId: discussion.id, sceneId: discussion.sceneId ?? (discussion.cueId ? cueScenes.get(discussion.cueId) : undefined), page: discussion.page, anchorY: discussion.anchorY, actorId: discussion.authorId, type: "note_added", text: "added a note.", createdAt: discussion.createdAt });
    }
    discussion.replies.forEach((reply) => {
      if (!history.some((event) => event.id === `migrated-${reply.id}` || (event.discussionId === discussion.id && event.type === "reply_added" && event.createdAt === reply.createdAt))) {
        events.push({ id: `migrated-${reply.id}`, cueId: discussion.cueId, discussionId: discussion.id, replyId: reply.id, sceneId: discussion.sceneId ?? (discussion.cueId ? cueScenes.get(discussion.cueId) : undefined), page: discussion.page, anchorY: discussion.anchorY, targetProfileIds: [discussion.authorId], actorId: reply.authorId, type: "reply_added", text: "replied to a note.", createdAt: reply.createdAt });
      }
    });
    return events;
  }) : [];
  return {
    ...saved,
    schemaVersion: defaultState.schemaVersion,
    document,
    scenes: normalizeScenes(saved.scenes ?? defaultState.scenes),
    profiles: saved.profiles ?? defaultState.profiles,
    discussions,
    history: [...history, ...migratedDiscussionHistory].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    inboxReads: saved.inboxReads ?? [],
    inboxPins: saved.inboxPins ?? [],
    conflicts: saved.conflicts ?? [],
    deletedCues: (saved.deletedCues ?? []).map((item) => ({ ...item, cue: { ...item.cue, number: readCueNumber(item.cue.number) }, discussions: item.discussions.map((discussion) => {
      const normalized = { ...discussion, targetType: discussion.targetType ?? (discussion.cueId ? "cue" : discussion.sceneId ? "scene" : "script"), replies: discussion.replies ?? [], resolved: discussion.resolved ?? false };
      delete normalized.kind;
      return normalized;
    }) })),
    cues,
  };
}

function boundedString(value: unknown, maximum = 10_000): value is string {
  return typeof value === "string" && value.length <= maximum;
}

export function safeWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
}

function uniqueIds(items: Array<{ id: string }>) {
  return new Set(items.map((item) => item.id)).size === items.length;
}

export function validWorkspaceState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as WorkspaceState;
  const collections = [state.profiles, state.cues, state.scenes, state.discussions, state.history, state.inboxReads, state.inboxPins, state.deletedCues];
  if (state.schemaVersion !== defaultState.schemaVersion || !collections.every(Array.isArray)) return false;
  if (!state.document || state.document.id !== defaultState.document.id || state.document.filename !== defaultState.document.filename || state.document.version !== defaultState.document.version || state.document.pages !== defaultState.document.pages) return false;
  if (!collections.every((items) => items.every((item) => item && typeof item === "object" && safeWorkspaceId(item.id)) && uniqueIds(items))) return false;

  const profileIds = new Set(state.profiles.map((profile) => profile.id));
  if (!state.profiles.every((profile) => boundedString(profile.name, 120) && boundedString(profile.role, 120) && boundedString(profile.initials, 3) && /^#[0-9a-f]{6}$/i.test(profile.color))) return false;

  const sceneDefaults = new Map(defaultState.scenes.map((scene) => [scene.id, scene]));
  if (state.scenes.length !== defaultState.scenes.length || !state.scenes.every((scene) => {
    const expected = sceneDefaults.get(scene.id);
    return !!expected && scene.number === expected.number && scene.name === expected.name && scene.pageStart === expected.pageStart && scene.pageEnd === expected.pageEnd && scene.startY === expected.startY && (scene.ownerId === null || profileIds.has(scene.ownerId));
  })) return false;
  const sceneIds = new Set(state.scenes.map((scene) => scene.id));

  const validCue = (cue: WorkspaceState["cues"][number]) => safeWorkspaceId(cue.id)
    && (cue.number === null || readCueNumber(cue.number) !== null)
    && boundedString(cue.title, 300)
    && boundedString(cue.description, 20_000)
    && boundedString(cue.technicalNotes, 20_000)
    && ["unassigned", "planned", "implemented"].includes(cue.mode)
    && ((cue.number === null && cue.mode === "unassigned") || (cue.number !== null && cue.mode !== "unassigned"))
    && typeof cue.blackout === "boolean"
    && sceneIds.has(cue.sceneId)
    && Number.isSafeInteger(cue.page) && cue.page >= 1 && cue.page <= state.document.pages
    && (cue.anchorType === "line" || cue.anchorType === "phrase")
    && boundedString(cue.selectedText, 10_000)
    && boundedString(cue.enclosingLine, 20_000)
    && (cue.anchorX === undefined || Number.isFinite(cue.anchorX) && cue.anchorX >= 0 && cue.anchorX <= 1)
    && (cue.anchorY === undefined || Number.isFinite(cue.anchorY) && cue.anchorY >= 0 && cue.anchorY <= 1)
    && Number.isFinite(cue.anchorOrder)
    && (cue.ownerId === undefined || profileIds.has(cue.ownerId));
  if (!state.cues.every(validCue) || !state.deletedCues.every((item) => item.id === item.cue.id && validCue(item.cue) && safeWorkspaceId(item.deletedBy) && profileIds.has(item.deletedBy) && !Number.isNaN(Date.parse(item.deletedAt)) && Array.isArray(item.discussions))) return false;
  const cueIds = new Set(state.cues.map((cue) => cue.id));
  const deletedCueIds = new Set(state.deletedCues.map((item) => item.cue.id));
  if ([...cueIds].some((id) => deletedCueIds.has(id))) return false;

  const validDiscussion = (discussion: WorkspaceState["discussions"][number]) => safeWorkspaceId(discussion.id)
    && profileIds.has(discussion.authorId)
    && boundedString(discussion.content, 20_000)
    && !Number.isNaN(Date.parse(discussion.createdAt))
    && typeof discussion.resolved === "boolean"
    && (discussion.resolvedBy === undefined || profileIds.has(discussion.resolvedBy))
    && Array.isArray(discussion.replies)
    && uniqueIds(discussion.replies)
    && discussion.replies.every((reply) => safeWorkspaceId(reply.id) && profileIds.has(reply.authorId) && boundedString(reply.content, 20_000) && !Number.isNaN(Date.parse(reply.createdAt)))
    && (discussion.cueId === undefined || cueIds.has(discussion.cueId) || deletedCueIds.has(discussion.cueId))
    && (discussion.sceneId === undefined || sceneIds.has(discussion.sceneId))
    && (discussion.page === undefined || Number.isSafeInteger(discussion.page) && discussion.page >= 1 && discussion.page <= state.document.pages)
    && (discussion.anchorX === undefined || Number.isFinite(discussion.anchorX) && discussion.anchorX >= 0 && discussion.anchorX <= 1)
    && (discussion.anchorY === undefined || Number.isFinite(discussion.anchorY) && discussion.anchorY >= 0 && discussion.anchorY <= 1)
    && (discussion.targetType === "cue" && !!discussion.cueId
      || discussion.targetType === "scene" && !!discussion.sceneId && discussion.cueId === undefined
      || discussion.targetType === "script" && discussion.cueId === undefined && discussion.sceneId === undefined);
  if (!state.discussions.every(validDiscussion) || !state.deletedCues.every((item) => item.discussions.every(validDiscussion))) return false;

  const historyIds = new Set(state.history.map((event) => event.id));
  const discussionIds = new Set([...state.discussions, ...state.deletedCues.flatMap((item) => item.discussions)].map((discussion) => discussion.id));
  const replyIds = new Set([...state.discussions, ...state.deletedCues.flatMap((item) => item.discussions)].flatMap((discussion) => discussion.replies.map((reply) => reply.id)));
  const activityTypes = new Set(["legacy", "note_added", "reply_added", "note_resolved", "note_reopened", "cue_created", "cue_status", "cue_number", "cue_anchor", "cue_blackout", "cue_edited", "scene_owner", "cue_deleted", "cue_restored"]);
  if (!state.history.every((event) => profileIds.has(event.actorId)
    && !!event.type && activityTypes.has(event.type)
    && boundedString(event.text, 20_000)
    && !Number.isNaN(Date.parse(event.createdAt))
    && (event.cueId === undefined || cueIds.has(event.cueId) || deletedCueIds.has(event.cueId))
    && (event.discussionId === undefined || discussionIds.has(event.discussionId))
    && (event.replyId === undefined || replyIds.has(event.replyId))
    && (event.sceneId === undefined || sceneIds.has(event.sceneId))
    && (event.sceneIds === undefined || Array.isArray(event.sceneIds) && event.sceneIds.every((id) => sceneIds.has(id)))
    && (event.targetProfileIds === undefined || Array.isArray(event.targetProfileIds) && event.targetProfileIds.every((id) => profileIds.has(id)))
    && (event.page === undefined || Number.isSafeInteger(event.page) && event.page >= 1 && event.page <= state.document.pages)
    && (event.anchorY === undefined || Number.isFinite(event.anchorY) && event.anchorY >= 0 && event.anchorY <= 1))) return false;
  if (!state.inboxReads.every((receipt) => historyIds.has(receipt.eventId) && profileIds.has(receipt.profileId) && !Number.isNaN(Date.parse(receipt.readAt)))) return false;
  if (!state.inboxPins.every((pin) => historyIds.has(pin.eventId) && profileIds.has(pin.profileId) && !Number.isNaN(Date.parse(pin.pinnedAt)))) return false;
  if (state.conflicts !== undefined && (!Array.isArray(state.conflicts) || !uniqueIds(state.conflicts) || !state.conflicts.every((conflict: WorkspaceConflictRecord) => safeWorkspaceId(conflict.id)
    && boundedString(conflict.path, 1_000)
    && Array.isArray(conflict.pathSegments) && conflict.pathSegments.length >= 2 && conflict.pathSegments.every((segment) => safeWorkspaceId(segment))
    && (conflict.kind === undefined || ["merge", "number-repair"].includes(conflict.kind))
    && (conflict.occurrenceId === undefined || safeWorkspaceId(conflict.occurrenceId))
    && ["open", "resolved"].includes(conflict.status)
    && (conflict.resolution === undefined || ["base", "remote", "incoming"].includes(conflict.resolution))
    && (conflict.resolvedBy === undefined || profileIds.has(conflict.resolvedBy))
    && (conflict.resolvedAt === undefined || !Number.isNaN(Date.parse(conflict.resolvedAt)))
    && (conflict.supersededBy === undefined || safeWorkspaceId(conflict.supersededBy))
    && !Number.isNaN(Date.parse(conflict.createdAt))))) return false;
  return true;
}
