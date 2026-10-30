import type { WorkspaceState } from "./types.ts";

// Script-specific data comes from the desktop show, before the shared workspace mounts.
export const defaultState: WorkspaceState = { schemaVersion: 12, document: { id: "empty", filename: "Script.pdf", version: "empty", pages: 1 }, profiles: [], scenes: [], cues: [], discussions: [], history: [], inboxReads: [], inboxPins: [], deletedCues: [] };
export function configureDefaultState(state: WorkspaceState) { Object.assign(defaultState, state); }
