export type Profile = {
  id: string;
  name: string;
  role: string;
  initials: string;
  color: string;
};

export type Scene = {
  id: string;
  number: string;
  name: string;
  pageStart: number;
  startY: number;
  pageEnd: number;
  ownerId: string | null;
};

export type Discussion = {
  id: string;
  /** Notes created before anchored notes existed omit targetType and use cueId. */
  targetType?: "cue" | "scene" | "script";
  cueId?: string;
  sceneId?: string;
  page?: number;
  anchorX?: number;
  anchorY?: number;
  selectedText?: string;
  enclosingLine?: string;
  authorId: string;
  /** Legacy records may still include their former note/question label. */
  kind?: "note" | "question";
  content: string;
  createdAt: string;
  resolved: boolean;
  resolvedBy?: string;
  replies: { id: string; authorId: string; content: string; createdAt: string }[];
};

export type ActivityType =
  | "legacy"
  | "note_added"
  | "reply_added"
  | "note_resolved"
  | "note_reopened"
  | "cue_created"
  | "cue_status"
  | "cue_number"
  | "cue_anchor"
  | "cue_blackout"
  | "cue_edited"
  | "scene_owner"
  | "cue_deleted"
  | "cue_restored";

export type Cue = {
  id: string;
  number: number | null;
  title: string;
  description: string;
  technicalNotes: string;
  mode: "unassigned" | "planned" | "implemented";
  blackout: boolean;
  sceneId: string;
  page: number;
  anchorType: "line" | "phrase";
  selectedText: string;
  enclosingLine: string;
  anchorX?: number;
  anchorY?: number;
  anchorOrder: number;
  ownerId?: string;
};

export type DeletedCue = {
  id: string;
  cue: Cue;
  discussions: Discussion[];
  deletedAt: string;
  deletedBy: string;
};

export type HistoryEvent = {
  id: string;
  cueId?: string;
  discussionId?: string;
  replyId?: string;
  sceneId?: string;
  page?: number;
  anchorY?: number;
  sceneIds?: string[];
  targetProfileIds?: string[];
  actorId: string;
  type?: ActivityType;
  text: string;
  createdAt: string;
};

export type InboxRead = {
  id: string;
  eventId: string;
  profileId: string;
  readAt: string;
};

export type InboxPin = {
  id: string;
  eventId: string;
  profileId: string;
  pinnedAt: string;
};

export type WorkspaceConflictRecord = {
  id: string;
  path: string;
  pathSegments: string[];
  base: unknown;
  remote: unknown;
  incoming: unknown;
  kind?: "merge" | "number-repair";
  repaired?: unknown;
  occurrenceId?: string;
  status: "open" | "resolved";
  resolution?: "base" | "remote" | "incoming";
  resolvedBy?: string;
  resolvedAt?: string;
  /** An older intermediate conflict closed by a newer decision for the same field. */
  supersededBy?: string;
  createdAt: string;
};

export type WorkspaceState = {
  schemaVersion: number;
  document: { id: string; filename: string; version: string; pages: number };
  profiles: Profile[];
  scenes: Scene[];
  cues: Cue[];
  discussions: Discussion[];
  history: HistoryEvent[];
  inboxReads: InboxRead[];
  inboxPins: InboxPin[];
  deletedCues: DeletedCue[];
  /** Optional so snapshots from before conflict persistence remain valid. */
  conflicts?: WorkspaceConflictRecord[];
};
