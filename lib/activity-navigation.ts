import type { HistoryEvent, WorkspaceState } from "./types.ts";

export function deletedCueForActivity(event: HistoryEvent, state: WorkspaceState) {
  return state.deletedCues.find((item) => item.id === event.cueId || event.discussionId && item.discussions.some((note) => note.id === event.discussionId));
}
