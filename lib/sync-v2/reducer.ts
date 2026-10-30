import { autoNumberForPlacement, formatCueNumber, isCueAssignmentValid, normalizeCueNumbers, NUMBER_SPACE_ERROR, parseCueNumber, planCueNumberAssignments, readCueNumber, sortCuesByPosition } from "../cue-numbering.ts";
import { FIELD_LIMITS } from "../field-limits.ts";
import { sceneAtPosition } from "../scene-boundaries.ts";
import type { Cue, Discussion, HistoryEvent, Profile, WorkspaceState } from "../types.ts";
import { addDiscussionReply, moveCueToTrash, restoreCueFromTrash } from "../workspace-actions.ts";
import type { OperationStatus, SyncAction } from "./protocol.ts";

export type CueVersions = { position: number; lifecycle: number; assignment: number; blackout: number };
export type ProjectionVersions = {
  cues: Record<string, CueVersions>;
  scenes: Record<string, number>;
  profiles: Record<string, number>;
  discussions: Record<string, number>;
};

export type VersionBumps = {
  cues?: Record<string, Partial<Record<keyof CueVersions, number>>>;
  scenes?: Record<string, number>;
  profiles?: Record<string, number>;
  discussions?: Record<string, number>;
};

export type StructuredReduction = {
  status: OperationStatus;
  state: WorkspaceState;
  code?: string;
  message?: string;
  outcome: Record<string, unknown>;
  bumps: VersionBumps;
};

export type ReducerContext = {
  actorId: string;
  operationId: string;
  createdAt: string;
};

function result(state: WorkspaceState, status: OperationStatus, outcome: Record<string, unknown> = {}, bumps: VersionBumps = {}, code?: string, message?: string): StructuredReduction {
  return { status, state, outcome, bumps, code, message };
}

function historyId(operationId: string) {
  return `sync-${operationId}`.slice(0, 200);
}

function appendHistory(state: WorkspaceState, event: Omit<HistoryEvent, "id">, operationId: string): WorkspaceState {
  const id = historyId(operationId);
  if (state.history.some((item) => item.id === id)) return state;
  return { ...state, history: [{ id, ...event }, ...state.history] };
}

function cueVersions(versions: ProjectionVersions, cueId: string): CueVersions {
  return versions.cues[cueId] ?? { position: 0, lifecycle: 0, assignment: 0, blackout: 0 };
}

function staleCueVersion(action: SyncAction & { cueId: string }, versions: ProjectionVersions) {
  const current = cueVersions(versions, action.cueId);
  if ("expectedPositionVersion" in action && action.expectedPositionVersion !== undefined && action.expectedPositionVersion !== current.position) return "position";
  if ("expectedLifecycleVersion" in action && action.expectedLifecycleVersion !== undefined && action.expectedLifecycleVersion !== current.lifecycle) return "lifecycle";
  if ("expectedAssignmentVersion" in action && action.expectedAssignmentVersion !== undefined && action.expectedAssignmentVersion !== current.assignment) return "assignment";
  if ("expectedBlackoutVersion" in action && action.expectedBlackoutVersion !== undefined && action.expectedBlackoutVersion !== current.blackout) return "blackout";
  return null;
}

function activeCue(state: WorkspaceState, cueId: string) {
  return state.cues.find((cue) => cue.id === cueId);
}

function withCue(state: WorkspaceState, cue: Cue) {
  return { ...state, cues: state.cues.map((item) => item.id === cue.id ? cue : item) };
}

function numberInUse(state: WorkspaceState, number: number, excludingCueId?: string) {
  return state.cues.some((cue) => cue.id !== excludingCueId && readCueNumber(cue.number) === number);
}

function assignmentFor(state: WorkspaceState, cue: Cue, requested?: number) {
  const number = requested && !numberInUse(state, requested, cue.id)
    ? requested
    : autoNumberForPlacement(state.cues.filter((item) => item.id !== cue.id), cue);
  return { number, adjusted: !!requested && requested !== number };
}

function sceneRecipients(state: WorkspaceState, sceneIds: string[]) {
  return [...new Set(sceneIds.flatMap((id) => {
    const owner = state.scenes.find((scene) => scene.id === id)?.ownerId;
    return owner ? [owner] : [];
  }))];
}

function validProfile(profile: Profile) {
  return !!profile.id && profile.name.trim().length > 0 && profile.name.length <= FIELD_LIMITS.profileName
    && profile.role.trim().length > 0 && profile.role.length <= FIELD_LIMITS.profileRole
    && profile.initials.trim().length > 0 && profile.initials.length <= FIELD_LIMITS.profileInitials
    && /^#[0-9a-f]{6}$/i.test(profile.color);
}

function validDiscussion(discussion: Discussion) {
  return !!discussion.id && !!discussion.authorId && discussion.content.trim().length > 0
    && discussion.content.length <= FIELD_LIMITS.note && !Number.isNaN(Date.parse(discussion.createdAt));
}

export function reduceStructuredAction(state: WorkspaceState, versions: ProjectionVersions, action: Exclude<SyncAction, { type: "applyTextUpdate" | "restoreTextVersion" | "acknowledgeNotice" }>, context: ReducerContext): StructuredReduction {
  state = normalizeCueNumbers(state);
  const actorId = context.actorId;
  const createdAt = context.createdAt;

  if (action.type === "createCue") {
    if (state.cues.some((cue) => cue.id === action.cue.id) || state.deletedCues.some((cue) => cue.id === action.cue.id)) return result(state, "unchanged", { cueId: action.cue.id });
    const scene = state.scenes.find((item) => item.id === action.cue.sceneId);
    if (!scene || !isCueAssignmentValid(action.cue.number, action.cue.mode)) return result(state, "invalid", {}, {}, "invalid_cue", "The cue has an invalid scene or assignment.");
    const requestedNumber = action.cue.number === null ? null : parseCueNumber(action.cue.number);
    if (action.cue.number !== null && requestedNumber === null) return result(state, "invalid", {}, {}, "invalid_number", "Use a positive cue number with at most three decimal places.");
    let cue = { ...action.cue, number: requestedNumber };
    let status: OperationStatus = "applied";
    if (cue.number && numberInUse(state, cue.number)) {
      cue = { ...cue, ...assignmentFor(state, cue, cue.number), mode: cue.mode === "implemented" ? "implemented" : "planned" };
      delete (cue as Cue & { adjusted?: boolean }).adjusted;
      status = "adjusted";
    }
    if (action.assignNumber && cue.number === null) cue = { ...cue, number: autoNumberForPlacement(state.cues, cue) };
    const exhausted = (action.assignNumber || requestedNumber !== null) && cue.number === null;
    if (exhausted) status = "adjusted";
    cue = { ...cue, mode: cue.number === null ? "unassigned" : cue.mode === "implemented" ? "implemented" : "planned" };
    const next = appendHistory({ ...state, cues: sortCuesByPosition([...state.cues, cue]) }, { cueId: cue.id, sceneId: cue.sceneId, actorId, type: "cue_created", text: `created ${formatCueNumber(cue.number, "an unassigned cue")} · ${cue.title}.`, createdAt }, context.operationId);
    return result(next, status, { cueId: cue.id, requested: action.cue.number, number: cue.number }, { cues: { [cue.id]: { position: 1, lifecycle: 1, assignment: 1, blackout: 1 } } }, exhausted ? "number_precision_exhausted" : status === "adjusted" ? "number_adjusted" : undefined, exhausted ? NUMBER_SPACE_ERROR : undefined);
  }

  if (action.type === "assignCueNumbers") {
    const requested = new Set(action.cues.map((item) => item.cueId));
    if (requested.size !== action.cues.length || action.cues.length > 500) return result(state, "invalid", {}, {}, "invalid_selection", "Select between 1 and 500 distinct cues.");
    for (const expected of action.cues) {
      const cue = activeCue(state, expected.cueId);
      const current = cueVersions(versions, expected.cueId);
      if (!cue || current.lifecycle !== expected.expectedLifecycleVersion || current.position !== expected.expectedPositionVersion) {
        return result(state, "not_applied", { cueId: expected.cueId }, {}, "selection_changed", "A selected cue moved or was deleted. No cue numbers were assigned.");
      }
      if (!cue.number && current.assignment !== expected.expectedAssignmentVersion) {
        return result(state, "not_applied", { cueId: expected.cueId }, {}, "assignment_changed", "A selected cue assignment changed. No cue numbers were assigned.");
      }
    }
    const { cues, assignments, failedCueId } = planCueNumberAssignments(state.cues, requested);
    if (failedCueId) return result(state, "not_applied", { cueId: failedCueId }, {}, "number_unavailable", "No free cue number fits in script order within three decimal places. No cue numbers were assigned.");
    const changed = assignments.filter((item) => !item.unchanged);
    if (!changed.length) return result(state, "unchanged", { assignments, assignedCount: 0, unchangedCount: assignments.length }, {}, "bulk_assigned");
    const bumps = Object.fromEntries(changed.map(({ cueId }) => [cueId, { assignment: cueVersions(versions, cueId).assignment + 1 }]));
    const sceneIds = [...new Set(changed.map(({ cueId }) => cues.find((cue) => cue.id === cueId)!.sceneId))];
    const next = appendHistory({ ...state, cues: sortCuesByPosition(cues) }, { sceneIds, targetProfileIds: sceneRecipients(state, sceneIds), actorId, type: "cue_number", text: `assigned ${changed.length} cue number${changed.length === 1 ? "" : "s"}.`, createdAt }, context.operationId);
    return result(next, "applied", { assignments, assignedCount: changed.length, unchangedCount: assignments.length - changed.length }, { cues: bumps }, "bulk_assigned");
  }

  if (action.type === "setSceneOwners") {
    if (!action.scenes.length || new Set(action.scenes.map((item) => item.sceneId)).size !== action.scenes.length) return result(state, "invalid", {}, {}, "invalid_scene_group", "The scene group is empty or contains duplicates.");
    const changed = action.scenes.filter((requested) => state.scenes.find((scene) => scene.id === requested.sceneId)?.ownerId !== requested.ownerId);
    const stale = changed.find((requested) => versions.scenes[requested.sceneId] !== requested.expectedVersion || !state.scenes.some((scene) => scene.id === requested.sceneId));
    if (stale) return result(state, "not_applied", { sceneId: stale.sceneId }, {}, "scene_changed", "Scene ownership changed before this request was saved.");
    if (!changed.length) return result(state, "unchanged", { sceneIds: action.scenes.map((item) => item.sceneId) });
    if (changed.some((item) => item.ownerId && !state.profiles.some((profile) => profile.id === item.ownerId))) return result(state, "invalid", {}, {}, "unknown_profile", "The requested owner does not exist.");
    const owners = new Map(changed.map((item) => [item.sceneId, item.ownerId]));
    const targetProfileIds = [...new Set(changed.flatMap((item) => [state.scenes.find((scene) => scene.id === item.sceneId)?.ownerId, item.ownerId]).filter((id): id is string => !!id))];
    const next = appendHistory({ ...state, scenes: state.scenes.map((scene) => owners.has(scene.id) ? { ...scene, ownerId: owners.get(scene.id) ?? null } : scene) }, { sceneIds: [...owners.keys()], targetProfileIds, actorId, type: "scene_owner", text: changed[0].ownerId ? "updated scene ownership." : "unassigned scene ownership.", createdAt }, context.operationId);
    return result(next, "applied", { sceneIds: [...owners.keys()] }, { scenes: Object.fromEntries(changed.map((item) => [item.sceneId, item.expectedVersion + 1])) });
  }

  if (action.type === "createOrUpdateProfile") {
    if (!validProfile(action.profile)) return result(state, "invalid", {}, {}, "invalid_profile", "The profile fields are invalid.");
    const existing = state.profiles.find((item) => item.id === action.profile.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(action.profile)) return result(state, "unchanged", { profileId: action.profile.id });
    if (existing && (action.expectedVersion === undefined || versions.profiles[action.profile.id] !== action.expectedVersion)) return result(state, "not_applied", { profileId: action.profile.id }, {}, "profile_changed", "The profile changed before this request was saved.");
    const profiles = existing ? state.profiles.map((item) => item.id === action.profile.id ? action.profile : item) : [...state.profiles, action.profile];
    const nextVersion = existing ? (versions.profiles[action.profile.id] ?? 1) + 1 : 1;
    return result({ ...state, profiles }, "applied", { profileId: action.profile.id }, { profiles: { [action.profile.id]: nextVersion } });
  }

  if (action.type === "addNote") {
    const requested = action.discussion;
    const targetCue = requested.cueId ? activeCue(state, requested.cueId) : undefined;
    const sceneId = requested.targetType === "cue" ? targetCue?.sceneId ?? requested.sceneId : requested.page !== undefined ? sceneAtPosition(state.scenes, requested.page, requested.anchorY ?? 0)?.id : undefined;
    const discussion = { ...requested, sceneId, content: requested.content.trim(), replies: requested.replies ?? [] };
    if (state.discussions.some((item) => item.id === discussion.id) || state.deletedCues.some((item) => item.discussions.some((note) => note.id === discussion.id))) return result(state, "unchanged", { discussionId: discussion.id });
    if (!validDiscussion(discussion) || !state.profiles.some((profile) => profile.id === discussion.authorId)) return result(state, "invalid", {}, {}, "invalid_note", "The note is invalid.");
    const cue = discussion.cueId ? activeCue(state, discussion.cueId) : undefined;
    const deleted = discussion.cueId ? state.deletedCues.find((item) => item.id === discussion.cueId) : undefined;
    if (discussion.targetType === "cue" && !cue && !deleted) return result(state, "not_applied", { discussionId: discussion.id }, {}, "target_missing", "The note target no longer exists.");
    let next = deleted
      ? { ...state, deletedCues: state.deletedCues.map((item) => item.id === deleted.id ? { ...item, discussions: [...item.discussions, discussion] } : item) }
      : { ...state, discussions: [...state.discussions, discussion] };
    const ownerId = state.scenes.find((scene) => scene.id === discussion.sceneId)?.ownerId;
    next = appendHistory(next, { cueId: discussion.cueId, discussionId: discussion.id, sceneId: discussion.sceneId ?? cue?.sceneId, page: discussion.page, anchorY: discussion.anchorY, targetProfileIds: ownerId ? [ownerId] : [], actorId, type: "note_added", text: "added a note.", createdAt }, context.operationId);
    return result(next, deleted ? "adjusted" : "applied", { discussionId: discussion.id, cueId: discussion.cueId, savedToDeletedCue: !!deleted }, { discussions: { [discussion.id]: 1 } }, deleted ? "saved_to_deleted_cue" : undefined);
  }

  if (action.type === "addReply") {
    const discussion = state.discussions.find((item) => item.id === action.discussionId);
    const deleted = state.deletedCues.find((item) => item.discussions.some((note) => note.id === action.discussionId));
    const target = discussion ?? deleted?.discussions.find((item) => item.id === action.discussionId);
    if (!target) return result(state, "not_applied", {}, {}, "target_missing", "The note thread no longer exists.");
    if (target.replies.some((reply) => reply.id === action.reply.id)) return result(state, "unchanged", { replyId: action.reply.id });
    if (!action.reply.content.trim() || action.reply.content.length > FIELD_LIMITS.reply || !state.profiles.some((profile) => profile.id === action.reply.authorId)) return result(state, "invalid", {}, {}, "invalid_reply", "The reply is invalid.");
    let next: WorkspaceState;
    if (discussion) {
      next = addDiscussionReply(state, action.discussionId, action.reply.authorId, action.reply.content, action.reply.createdAt, action.reply.id, historyId(context.operationId));
    } else {
      const reply = { ...action.reply, content: action.reply.content.trim() };
      next = { ...state, deletedCues: state.deletedCues.map((item) => item.id === deleted?.id ? { ...item, discussions: item.discussions.map((note) => note.id === action.discussionId ? { ...note, replies: [...note.replies, reply] } : note) } : item) };
      next = appendHistory(next, { cueId: target.cueId, discussionId: target.id, replyId: reply.id, sceneId: target.sceneId, page: target.page, anchorY: target.anchorY, actorId, type: "reply_added", text: "replied to a note.", createdAt }, context.operationId);
    }
    return result(next, deleted ? "adjusted" : "applied", { replyId: action.reply.id, cueId: target.cueId, savedToDeletedCue: !!deleted }, { discussions: { [target.id]: (versions.discussions[target.id] ?? 1) + 1 } }, deleted ? "saved_to_deleted_cue" : undefined);
  }

  if (action.type === "setDiscussionResolved") {
    const discussion = state.discussions.find((item) => item.id === action.discussionId);
    if (!discussion) return result(state, "not_applied", {}, {}, "target_missing", "The note thread is unavailable.");
    if (discussion.resolved === action.resolved) return result(state, "unchanged", { discussionId: discussion.id, resolved: action.resolved });
    if (versions.discussions[discussion.id] !== action.expectedVersion) return result(state, "not_applied", { discussionId: discussion.id, resolved: discussion.resolved }, {}, "discussion_changed", "The note changed before this request was saved.");
    let next = { ...state, discussions: state.discussions.map((item) => item.id === discussion.id ? { ...item, resolved: action.resolved, resolvedBy: actorId } : item) };
    next = appendHistory(next, { cueId: discussion.cueId, discussionId: discussion.id, sceneId: discussion.sceneId, page: discussion.page, anchorY: discussion.anchorY, actorId, type: action.resolved ? "note_resolved" : "note_reopened", text: action.resolved ? "resolved a note." : "reopened a note.", createdAt }, context.operationId);
    return result(next, "applied", { discussionId: discussion.id, resolved: action.resolved }, { discussions: { [discussion.id]: action.expectedVersion + 1 } });
  }

  if (action.type === "setInboxRead" || action.type === "setInboxPinned") {
    const known = new Set(state.history.map((event) => event.id));
    const eventIds = [...new Set(action.eventIds)].filter((id) => known.has(id));
    if (!eventIds.length) return result(state, "unchanged", { eventIds: [] }, {}, "events_missing");
    const current = action.type === "setInboxRead" ? state.inboxReads : state.inboxPins;
    const desired = action.type === "setInboxRead" ? action.read : action.pinned;
    const key = (eventId: string) => `${eventId}:${action.profileId}`;
    const selected = new Set(eventIds.map(key));
    const without = current.filter((item) => !selected.has(key(item.eventId)));
    const nextItems = desired ? [...without, ...eventIds.map((eventId) => action.type === "setInboxRead"
      ? { id: `read-${action.profileId}-${eventId}`.slice(0, 200), eventId, profileId: action.profileId, readAt: createdAt }
      : { id: `pin-${action.profileId}-${eventId}`.slice(0, 200), eventId, profileId: action.profileId, pinnedAt: createdAt })] : without;
    const same = JSON.stringify(current) === JSON.stringify(nextItems);
    if (same) return result(state, "unchanged", { eventIds, desired });
    return result(action.type === "setInboxRead" ? { ...state, inboxReads: nextItems as WorkspaceState["inboxReads"] } : { ...state, inboxPins: nextItems as WorkspaceState["inboxPins"] }, "applied", { eventIds, desired });
  }

  if (action.type === "assignNextNumber" || action.type === "setCueNumber" || action.type === "unassignCue" || action.type === "setCueMode" || action.type === "setBlackout" || action.type === "moveCue" || action.type === "deleteCue" || action.type === "restoreCue") {
    const cue = activeCue(state, action.cueId);
    const deleted = state.deletedCues.find((item) => item.id === action.cueId);
    const stale = staleCueVersion(action, versions);

    if (action.type === "restoreCue") {
      if (!deleted) return cue ? result(state, "unchanged", { cueId: cue.id }) : result(state, "not_applied", {}, {}, "target_missing", "The deleted cue is unavailable.");
      if (stale) return result(state, "not_applied", { cueId: action.cueId }, {}, `${stale}_changed`, "The cue changed before this restore request was saved.");
      const requested = deleted.cue.number;
      let restored = restoreCueFromTrash(state, action.cueId, actorId, createdAt, historyId(context.operationId));
      const item = restored.cues.find((candidate) => candidate.id === action.cueId);
      let status: OperationStatus = "applied";
      if (item?.number && numberInUse(restored, item.number, item.id)) {
        const assigned = assignmentFor(restored, item, item.number);
        restored = withCue(restored, { ...item, number: assigned.number, mode: assigned.number === null ? "unassigned" : item.mode === "implemented" ? "implemented" : "planned" });
        status = "adjusted";
      }
      const current = cueVersions(versions, action.cueId);
      return result(restored, status, { cueId: action.cueId, requested, number: restored.cues.find((item) => item.id === action.cueId)?.number }, { cues: { [action.cueId]: { lifecycle: current.lifecycle + 1, assignment: current.assignment + (status === "adjusted" ? 1 : 0) } } }, status === "adjusted" ? restored.cues.find((item) => item.id === action.cueId)?.number === null ? "number_precision_exhausted" : "restore_number_adjusted" : undefined, status === "adjusted" && restored.cues.find((item) => item.id === action.cueId)?.number === null ? NUMBER_SPACE_ERROR : undefined);
    }

    if (!cue) return result(state, "not_applied", { cueId: action.cueId, deleted: !!deleted }, {}, deleted ? "cue_deleted" : "target_missing", deleted ? "This cue is in Recently deleted." : "The cue is unavailable.");
    if (action.type === "setBlackout" && cue.blackout === action.blackout) return result(state, "unchanged", { cueId: cue.id, blackout: cue.blackout });
    if (action.type === "setCueMode" && cue.mode === action.mode) return result(state, "unchanged", { cueId: cue.id, mode: cue.mode });
    if (action.type === "unassignCue" && !cue.number && cue.mode === "unassigned") return result(state, "unchanged", { cueId: cue.id });
    if (action.type === "setCueNumber" && cue.number === parseCueNumber(action.number)) return result(state, "unchanged", { cueId: cue.id, number: cue.number });
    if (stale) return result(state, "not_applied", { cueId: cue.id, current: cue }, {}, `${stale}_changed`, `The cue ${stale} changed before this request was saved.`);

    if (action.type === "deleteCue") {
      const next = moveCueToTrash(state, cue.id, actorId, createdAt, historyId(context.operationId));
      return result(next, "applied", { cueId: cue.id }, { cues: { [cue.id]: { lifecycle: cueVersions(versions, cue.id).lifecycle + 1 } } });
    }
    if (action.type === "assignNextNumber") {
      if (cue.number) return result(state, "unchanged", { cueId: cue.id, number: cue.number });
      const number = assignmentFor(state, cue).number;
      if (number === null) return result(state, "not_applied", { cueId: cue.id }, {}, "number_unavailable", NUMBER_SPACE_ERROR);
      const nextCue = { ...cue, number, mode: "planned" as const };
      const next = appendHistory(withCue(state, nextCue), { cueId: cue.id, sceneId: cue.sceneId, actorId, type: "cue_number", text: `assigned ${formatCueNumber(number)}.`, createdAt }, context.operationId);
      return result(next, "applied", { cueId: cue.id, number }, { cues: { [cue.id]: { assignment: cueVersions(versions, cue.id).assignment + 1 } } });
    }
    if (action.type === "setCueNumber") {
      const requested = parseCueNumber(action.number);
      if (!requested) return result(state, "invalid", {}, {}, "invalid_number", "Use a positive cue number such as LX 2.1.");
      if (cue.number === requested) return result(state, "unchanged", { cueId: cue.id, number: cue.number });
      if (numberInUse(state, requested, cue.id)) return result(state, "not_applied", { cueId: cue.id, requested, number: cue.number }, {}, "number_in_use", `${formatCueNumber(requested)} is already in use. The current number was kept. Choose a different number.`);
      const nextCue = { ...cue, number: requested, mode: cue.mode === "implemented" ? "implemented" as const : "planned" as const };
      const next = appendHistory(withCue(state, nextCue), { cueId: cue.id, sceneId: cue.sceneId, actorId, type: "cue_number", text: `set the cue number to ${formatCueNumber(requested)}.`, createdAt }, context.operationId);
      return result(next, "applied", { cueId: cue.id, requested, number: requested }, { cues: { [cue.id]: { assignment: cueVersions(versions, cue.id).assignment + 1 } } });
    }
    if (action.type === "unassignCue") {
      if (!cue.number && cue.mode === "unassigned") return result(state, "unchanged", { cueId: cue.id });
      const next = appendHistory(withCue(state, { ...cue, number: null, mode: "unassigned" }), { cueId: cue.id, sceneId: cue.sceneId, actorId, type: "cue_number", text: "unassigned the cue number.", createdAt }, context.operationId);
      return result(next, "applied", { cueId: cue.id }, { cues: { [cue.id]: { assignment: cueVersions(versions, cue.id).assignment + 1 } } });
    }
    if (action.type === "setCueMode") {
      if (action.mode === "unassigned" && cue.number || action.mode !== "unassigned" && !cue.number) return result(state, "invalid", { cueId: cue.id }, {}, "invalid_mode", "Assign a cue number before changing its planned or implemented status.");
      if (cue.mode === action.mode) return result(state, "unchanged", { cueId: cue.id, mode: cue.mode });
      const next = appendHistory(withCue(state, { ...cue, mode: action.mode }), { cueId: cue.id, sceneId: cue.sceneId, actorId, type: "cue_status", text: `marked the cue ${action.mode}.`, createdAt }, context.operationId);
      return result(next, "applied", { cueId: cue.id, mode: action.mode }, { cues: { [cue.id]: { assignment: cueVersions(versions, cue.id).assignment + 1 } } });
    }
    if (action.type === "setBlackout") {
      if (cue.blackout === action.blackout) return result(state, "unchanged", { cueId: cue.id, blackout: cue.blackout });
      const next = appendHistory(withCue(state, { ...cue, blackout: action.blackout }), { cueId: cue.id, sceneId: cue.sceneId, actorId, type: "cue_blackout", text: action.blackout ? "marked BLACKOUT." : "removed BLACKOUT.", createdAt }, context.operationId);
      return result(next, "applied", { cueId: cue.id, blackout: action.blackout }, { cues: { [cue.id]: { blackout: cueVersions(versions, cue.id).blackout + 1 } } });
    }
    if (action.type === "moveCue") {
      if (!state.scenes.some((scene) => scene.id === action.position.sceneId)) return result(state, "invalid", {}, {}, "invalid_scene", "The target scene is unavailable.");
      const moved = { ...cue, ...action.position };
      const number = cue.number === null ? null : autoNumberForPlacement(state.cues.filter((item) => item.id !== cue.id), moved);
      const exhausted = cue.number !== null && number === null;
      const nextCue = { ...moved, number, mode: number === null ? "unassigned" as const : cue.mode === "implemented" ? "implemented" as const : "planned" as const };
      const sceneIds = [...new Set([cue.sceneId, nextCue.sceneId])];
      const next = appendHistory({ ...state, cues: sortCuesByPosition(state.cues.map((item) => item.id === cue.id ? nextCue : item)) }, { cueId: cue.id, sceneId: nextCue.sceneId, sceneIds, targetProfileIds: sceneRecipients(state, sceneIds), page: nextCue.page, anchorY: nextCue.anchorY, actorId, type: "cue_anchor", text: exhausted ? "moved the cue anchor; no number fits within three decimal places, so the cue is unassigned." : number !== cue.number ? `moved the cue anchor and renumbered it ${formatCueNumber(number)}.` : "moved the cue anchor.", createdAt }, context.operationId);
      const current = cueVersions(versions, cue.id);
      return result(next, exhausted ? "adjusted" : "applied", { cueId: cue.id, number }, { cues: { [cue.id]: { position: current.position + 1, assignment: current.assignment + (number !== cue.number ? 1 : 0) } } }, exhausted ? "number_precision_exhausted" : undefined, exhausted ? NUMBER_SPACE_ERROR : undefined);
    }
  }

  return result(state, "invalid", {}, {}, "unsupported_action", "This action is not supported.");
}
