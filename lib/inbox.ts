import type { ActivityType, HistoryEvent, WorkspaceState } from "./types";

export type InboxType = "all" | "notes" | "replies" | "cues" | "changes" | "resolutions" | "scenes";

export type InboxEventStack = {
  id: string;
  actionType: ActivityType | "legacy";
  discussionId?: string;
  events: HistoryEvent[];
  newestAt: string;
};
export type InboxStackMode = "current" | "past" | "all";

const INBOX_STACK_WINDOW_MS = 12 * 60 * 60 * 1000;
const CURRENT_STACKABLE_ACTIVITY_TYPES = new Set<ActivityType>([
  "cue_created",
  "cue_status",
  "cue_number",
  "cue_anchor",
  "cue_blackout",
  "cue_edited",
  "cue_deleted",
  "cue_restored",
  "scene_owner",
]);

export function activityTypeGroup(event: HistoryEvent): Exclude<InboxType, "all"> {
  if (event.type === "note_added") return "notes";
  if (event.type === "reply_added") return "replies";
  if (event.type === "note_resolved" || event.type === "note_reopened") return "resolutions";
  if (event.type === "cue_created") return "cues";
  if (event.type === "scene_owner") return "scenes";
  return "changes";
}

export function activitySceneIds(event: HistoryEvent, state: WorkspaceState) {
  const ids = new Set(event.sceneIds ?? []);
  if (event.sceneId) ids.add(event.sceneId);
  if (ids.size === 0) {
    const cue = event.cueId ? state.cues.find((item) => item.id === event.cueId)
      ?? state.deletedCues.find((item) => item.id === event.cueId)?.cue : undefined;
    if (cue?.sceneId) ids.add(cue.sceneId);
  }
  return [...ids];
}

function isNoteInOwnedScene(event: HistoryEvent, profileId: string, state: WorkspaceState) {
  return event.type === "note_added" && activitySceneIds(event, state)
    .some((sceneId) => state.scenes.find((scene) => scene.id === sceneId)?.ownerId === profileId);
}

export function isInboxActivityEligible(event: HistoryEvent, profileId: string, state: WorkspaceState) {
  return event.actorId !== profileId || isNoteInOwnedScene(event, profileId, state);
}

export function isActivityForProfile(event: HistoryEvent, profileId: string, state: WorkspaceState) {
  if (!isInboxActivityEligible(event, profileId, state)) return false;
  if (event.actorId === profileId) return true;
  if (event.targetProfileIds !== undefined) return event.targetProfileIds.includes(profileId);
  if (event.discussionId && (event.type === "reply_added" || event.type === "note_resolved" || event.type === "note_reopened")) {
    const discussion = state.discussions.find((item) => item.id === event.discussionId)
      ?? state.deletedCues.flatMap((item) => item.discussions).find((item) => item.id === event.discussionId);
    if (discussion?.authorId === profileId) return true;
  }
  return activitySceneIds(event, state).some((sceneId) => state.scenes.find((scene) => scene.id === sceneId)?.ownerId === profileId);
}

export function isActivityRead(event: HistoryEvent, profileId: string, state: WorkspaceState) {
  return state.inboxReads.some((receipt) => receipt.eventId === event.id && receipt.profileId === profileId);
}

export function isActivityPinned(event: HistoryEvent, profileId: string, state: WorkspaceState) {
  return state.inboxPins.some((pin) => pin.eventId === event.id && pin.profileId === profileId);
}

export function activityRequiresAction(event: HistoryEvent, state: WorkspaceState) {
  if (!event.discussionId || !["note_added", "reply_added", "note_reopened"].includes(event.type ?? "")) return false;
  return state.discussions.some((discussion) => discussion.id === event.discussionId && !discussion.resolved);
}

export function isActivityCurrent(event: HistoryEvent, profileId: string, state: WorkspaceState) {
  if (isActivityPinned(event, profileId, state)) return true;
  const discussion = event.discussionId ? state.discussions.find((item) => item.id === event.discussionId) : undefined;
  if (discussion?.resolved) return false;
  return activityRequiresAction(event, state) || !isActivityRead(event, profileId, state);
}

export function inboxEventsForProfile(state: WorkspaceState, profileId: string) {
  return collapseResolutionEvents(state.history).filter((event) => isActivityForProfile(event, profileId, state) || isActivityPinned(event, profileId, state));
}

export function currentInboxEventsForProfile(state: WorkspaceState, profileId: string) {
  return inboxEventsForProfile(state, profileId).filter((event) => isActivityCurrent(event, profileId, state));
}

export function stackInboxEvents(events: HistoryEvent[], mode: InboxStackMode = "current"): InboxEventStack[] {
  const stacks: InboxEventStack[] = [];
  const openStackByType = new Map<ActivityType, InboxEventStack>();
  [...events].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).forEach((event) => {
    const actionType = event.type ?? "legacy";
    const canStack = mode !== "current" || CURRENT_STACKABLE_ACTIVITY_TYPES.has(actionType);
    const openStack = canStack ? openStackByType.get(actionType) : undefined;
    const withinWindow = openStack
      ? new Date(openStack.newestAt).getTime() - new Date(event.createdAt).getTime() <= INBOX_STACK_WINDOW_MS
      : false;
    if (openStack && withinWindow) {
      if (openStack.discussionId !== event.discussionId) openStack.discussionId = undefined;
      openStack.events.push(event);
      return;
    }
    const stack = { id: `activity:${actionType}:${event.id}`, actionType, discussionId: event.discussionId, events: [event], newestAt: event.createdAt } satisfies InboxEventStack;
    stacks.push(stack);
    if (canStack) openStackByType.set(actionType, stack);
  });
  return stacks.sort((left, right) => right.newestAt.localeCompare(left.newestAt));
}

export function unresolvedDiscussionActivityCount(state: WorkspaceState, cueId: string) {
  return state.discussions
    .filter((discussion) => discussion.cueId === cueId && !discussion.resolved)
    .reduce((total, discussion) => total + 1 + discussion.replies.length, 0);
}

export function collapseResolutionEvents(events: HistoryEvent[]) {
  const latestByDiscussion = new Map<string, HistoryEvent>();
  events.forEach((event) => {
    if (!event.discussionId || (event.type !== "note_resolved" && event.type !== "note_reopened")) return;
    const current = latestByDiscussion.get(event.discussionId);
    if (!current || event.createdAt > current.createdAt || (event.createdAt === current.createdAt && event.id > current.id)) latestByDiscussion.set(event.discussionId, event);
  });
  return events.filter((event) => !event.discussionId
    || (event.type !== "note_resolved" && event.type !== "note_reopened")
    || latestByDiscussion.get(event.discussionId)?.id === event.id);
}
