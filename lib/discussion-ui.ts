import type { Discussion, Profile } from "./types";

/** A script note can also carry its scene association for history and routing. */
export function discussionTargetType(discussion: Pick<Discussion, "targetType" | "cueId" | "sceneId">) {
  return discussion.targetType ?? (discussion.cueId ? "cue" : discussion.sceneId ? "scene" : "script");
}

/** Attached notes follow their target; saved coordinates belong to script notes. */
export function discussionPage(discussion: Discussion, cuePages: ReadonlyMap<string, number>, scenePages: ReadonlyMap<string, number>) {
  const target = discussionTargetType(discussion);
  if (target === "cue") return discussion.cueId ? cuePages.get(discussion.cueId) : undefined;
  if (target === "scene") return discussion.sceneId ? scenePages.get(discussion.sceneId) : undefined;
  return discussion.page;
}

export function replyParticipantIds(discussion: Discussion) {
  return [...new Set(discussion.replies.map((reply) => reply.authorId))];
}

export type ReplyParticipant = { id: string; name: string; initials: string };

export type ReplyParticipation = {
  replyCount: number;
  participants: ReplyParticipant[];
  participantSummary: string;
};

/**
 * Keep reply totals and unique participant identity separate so a thread can
 * show both without making cue badges count reply events as extra notes.
 */
export function getReplyParticipation(discussion: Discussion, profiles: Profile[]): ReplyParticipation {
  const participants = replyParticipantIds(discussion).map((id): ReplyParticipant => {
    const profile = profiles.find((candidate) => candidate.id === id);
    return {
      id,
      name: profile?.name ?? id,
      initials: profile?.initials ?? id.slice(0, 2).toUpperCase(),
    };
  });
  const participantSummary = participants.length === 0
    ? "No replies"
    : participants.length === 1
      ? participants[0].name
      : `${participants[0].name} + ${participants.length - 1} ${participants.length === 2 ? "other" : "others"}`;
  return { replyCount: discussion.replies.length, participants, participantSummary };
}

export function replyParticipationLabel(discussion: Discussion, profiles: Profile[]) {
  const participation = getReplyParticipation(discussion, profiles);
  if (participation.replyCount === 0) return participation.participantSummary;
  return `${participation.participantSummary} · ${participation.replyCount} ${participation.replyCount === 1 ? "reply" : "replies"}`;
}

export function replyParticipantInitials(discussion: Discussion, profiles: Profile[]) {
  return getReplyParticipation(discussion, profiles).participants.map((participant) => participant.initials);
}
