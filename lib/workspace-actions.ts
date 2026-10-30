import { formatCueNumber, sortCuesByPosition } from "./cue-numbering.ts";
import { FIELD_LIMITS } from "./field-limits.ts";
import type { DeletedCue, Discussion, Profile, WorkspaceState } from "./types";

export function addDiscussionReply(
  state: WorkspaceState,
  discussionId: string,
  authorId: string,
  content: string,
  createdAt: string,
  replyId: string,
  historyId: string,
): WorkspaceState {
  const trimmed = content.trim();
  const discussion = state.discussions.find((item) => item.id === discussionId);
  if (!discussion || !trimmed || trimmed.length > FIELD_LIMITS.reply) return state;
  const cue = discussion.cueId ? state.cues.find((item) => item.id === discussion.cueId) : undefined;
  const sceneId = discussion.sceneId ?? cue?.sceneId;
  const sceneOwner = state.scenes.find((scene) => scene.id === sceneId)?.ownerId;
  const targets = [...new Set([discussion.authorId, sceneOwner].filter((id): id is string => !!id))];
  return {
    ...state,
    discussions: state.discussions.map((item) => item.id === discussionId ? {
      ...item,
      replies: [...item.replies, { id: replyId, authorId, content: trimmed, createdAt }],
    } : item),
    history: [{ id: historyId, cueId: discussion.cueId, discussionId, replyId, sceneId, page: discussion.page, anchorY: discussion.anchorY, targetProfileIds: targets, actorId: authorId, type: "reply_added", text: "replied to a note.", createdAt }, ...state.history],
  };
}

export function moveCueToTrash(
  state: WorkspaceState,
  cueId: string,
  actorId: string,
  deletedAt: string,
  historyId: string,
): WorkspaceState {
  const cue = state.cues.find((item) => item.id === cueId);
  if (!cue) return state;
  const targetProfileIds = [state.scenes.find((scene) => scene.id === cue.sceneId)?.ownerId].filter((id): id is string => !!id);
  const deleted: DeletedCue = {
    id: cue.id,
    cue,
    discussions: state.discussions.filter((item) => item.cueId === cueId && (item.targetType ?? "cue") === "cue"),
    deletedAt,
    deletedBy: actorId,
  };
  return {
    ...state,
    cues: state.cues.filter((item) => item.id !== cueId),
    discussions: state.discussions.filter((item) => !(item.cueId === cueId && (item.targetType ?? "cue") === "cue")),
    deletedCues: [deleted, ...state.deletedCues.filter((item) => item.id !== cueId)],
    history: [{ id: historyId, cueId, sceneId: cue.sceneId, targetProfileIds, actorId, type: "cue_deleted", text: `moved ${formatCueNumber(cue.number, "an unassigned cue")} · ${cue.title} to Recently deleted.`, createdAt: deletedAt }, ...state.history],
  };
}

export function restoreCueFromTrash(
  state: WorkspaceState,
  cueId: string,
  actorId: string,
  restoredAt: string,
  historyId: string,
): WorkspaceState {
  const deleted = state.deletedCues.find((item) => item.id === cueId);
  if (!deleted || state.cues.some((item) => item.id === cueId)) return state;
  const restoredDiscussions = deleted.discussions.filter((item) => !state.discussions.some((existing) => existing.id === item.id));
  const targetProfileIds = [state.scenes.find((scene) => scene.id === deleted.cue.sceneId)?.ownerId].filter((id): id is string => !!id);
  return {
    ...state,
    cues: sortCuesByPosition([...state.cues, deleted.cue]),
    discussions: [...restoredDiscussions, ...state.discussions],
    deletedCues: state.deletedCues.filter((item) => item.id !== cueId),
    history: [{ id: historyId, cueId, sceneId: deleted.cue.sceneId, targetProfileIds, actorId, type: "cue_restored", text: `restored ${formatCueNumber(deleted.cue.number, "an unassigned cue")} · ${deleted.cue.title}.`, createdAt: restoredAt }, ...state.history],
  };
}

export function saveProfile(state: WorkspaceState, profile: Profile): WorkspaceState {
  const normalized: Profile = {
    ...profile,
    name: profile.name.trim(),
    role: profile.role.trim(),
    initials: profile.initials.trim().toUpperCase(),
    color: /^#[0-9a-f]{6}$/i.test(profile.color) ? profile.color : "#8a929f",
  };
  if (!normalized.name || !normalized.role || !normalized.initials
    || normalized.name.length > FIELD_LIMITS.profileName
    || normalized.role.length > FIELD_LIMITS.profileRole
    || normalized.initials.length > FIELD_LIMITS.profileInitials) return state;
  const exists = state.profiles.some((item) => item.id === normalized.id);
  return {
    ...state,
    profiles: exists
      ? state.profiles.map((item) => item.id === normalized.id ? normalized : item)
      : [...state.profiles, normalized],
  };
}

export function discussionMatches(discussion: Discussion, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return false;
  return discussion.content.toLowerCase().includes(normalized)
    || discussion.replies.some((reply) => reply.content.toLowerCase().includes(normalized));
}
