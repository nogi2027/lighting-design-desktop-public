import { cueNumbersForTransport } from "../cue-numbering.ts";
import type { WorkspaceState } from "../types.ts";
import { normalizeWorkspaceState, validWorkspaceState } from "../workspace-state.ts";
import { sha256, stableJson } from "./encoding.ts";
import { loadSyncProjection, readCanonicalTextDocument, readSyncHead } from "./server-storage.ts";
import { decodeCanonicalTextDocument } from "./yjs-document.ts";

const workspaceId = "lighting-design";

function replaceCueText(state: WorkspaceState, cueId: string, text: { title: string; description: string; technicalNotes: string }) {
  const cue = state.cues.find((item) => item.id === cueId) ?? state.deletedCues.find((item) => item.id === cueId)?.cue;
  if (!cue) throw new Error(`Canonical text exists for unknown cue ${cueId}.`);
  cue.title = text.title;
  cue.description = text.description;
  cue.technicalNotes = text.technicalNotes;
}

function counts(state: WorkspaceState) {
  return {
    profiles: state.profiles.length,
    scenes: state.scenes.length,
    cues: state.cues.length,
    deletedCues: state.deletedCues.length,
    discussions: state.discussions.length + state.deletedCues.reduce((sum, item) => sum + item.discussions.length, 0),
    replies: [...state.discussions, ...state.deletedCues.flatMap((item) => item.discussions)].reduce((sum, item) => sum + item.replies.length, 0),
    history: state.history.length,
    inboxReads: state.inboxReads.length,
    inboxPins: state.inboxPins.length,
    conflicts: state.conflicts?.length ?? 0,
  };
}

export async function createV1RollbackSnapshot(db: D1Database) {
  const head = await readSyncHead(db);
  if (!head || head.workspace_id !== workspaceId) throw new Error("Sync v2 is not available for this workspace.");
  if (head.write_mode === "legacy") throw new Error("The workspace already uses legacy sync.");

  const projection = await loadSyncProjection(db);
  const state = structuredClone(projection.state);
  const allCueIds = [...state.cues.map((cue) => cue.id), ...state.deletedCues.map((item) => item.id)];
  for (const cueId of allCueIds) {
    const document = await readCanonicalTextDocument(db, cueId);
    if (!document) throw new Error(`Canonical text is missing for cue ${cueId}.`);
    replaceCueText(state, cueId, decodeCanonicalTextDocument(document.encodedState));
  }

  const normalized = normalizeWorkspaceState(state);
  if (!validWorkspaceState(normalized)) throw new Error("The generated v1 workspace failed the legacy validator.");
  const legacy = cueNumbersForTransport(normalized);
  const payload = JSON.stringify(legacy);
  const stableHash = await sha256(stableJson(legacy));
  return {
    state: legacy,
    payload,
    payloadBytes: new TextEncoder().encode(payload).byteLength,
    stableHash,
    source: { workspaceId, epoch: head.epoch, sequence: head.sequence, writeMode: head.write_mode },
    counts: counts(normalized),
  };
}
