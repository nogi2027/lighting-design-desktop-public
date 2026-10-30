export const SYNC_NOTICE_COPY = {
  N01: "Checking connection. Editing is paused.",
  N02: "Offline. You can view the saved workspace. Reconnect to edit.",
  N03: "Connection lost. Editing is paused. Showing the workspace saved at {time}.",
  N04: "Editing is paused. {count} changes are saved on this device and waiting to reach the server.",
  N05: "Reconnected. Checking saved changes before editing resumes.",
  N06: "Reconnected. Your pending changes are saved to the server.",
  N07: "Saving on this device…",
  N08: "Saved on this device. Sending…",
  N09: "Checking whether your last change was saved. Editing is paused.",
  N10: "Saved to server",
  N11: "This change could not be saved on this device. Keep this tab open and copy or download your text. Editing is paused.",
  N12: "Draft saved on this device. Not posted.",
  N13: "{requested} was already in use. {cue} was assigned {assigned}.",
  N14: "A number could not be assigned. {cue} is still unassigned.",
  N15: "{field} changed before your update arrived. Kept {current}. Your request is saved in history.",
  N16: "{cue} was moved to Recently deleted. Editing this cue is paused.",
  N17: "Your change was saved with {cue} in Recently deleted.",
  N18: "{cue} was restored as {assigned}; {requested} is already in use.",
  N19: "This cue moved before your change arrived. Kept its current position. Your requested move is saved in history.",
  N20: "This field also changed elsewhere. View history.",
  N21: "This field is {count} characters over the limit after combining edits. All text was kept. Shorten it to add more.",
  N22: "This paste is too long for {field}. It was kept as a draft.",
  N23: "This change could not be applied: {specificReason}. Your draft was kept.",
  N24: "An update is required before editing can resume. Your pending work will be kept.",
  N25: "Editing is temporarily paused for an update. You can keep viewing the workspace.",
  N26: "Some content is not saved on this device. Reconnect to load {content}.",
  N27: "Connect to load this workspace. No saved copy is available on this device.",
  N28: "{count} saved changes need attention. They have not been discarded.",
  N29: "The server is busy. Your saved changes will retry automatically.",
  N30: "Access to the server is unavailable. Editing is paused; pending changes remain on this device.",
  N31: "This field changed while you were reviewing the old version. Review the latest preview before restoring.",
  N32: "Reconnected. The latest team changes are loaded.",
  N33: "A change to {cue} was not saved. Review it before using that control again.",
  N34: "Assigned numbers to {count} cues. {unchangedCount} already had numbers and were kept.",
  N35: "No new numbers were assigned. {specificReason}. Review the selected cues and try again.",
  N36: "Backup is not complete yet. {completed} of {total} parts are verified.",
  N37: "Editing {cue} is paused because its saved history could not be processed safely. Your pending work was kept.",
} as const;

export type SyncNoticeId = keyof typeof SYNC_NOTICE_COPY;

export function syncNotice(id: SyncNoticeId, values: Record<string, string | number> = {}) {
  return SYNC_NOTICE_COPY[id].replace(/\{([A-Za-z]+)\}/g, (_match, name: string) => {
    if (!(name in values)) throw new Error(`Missing ${name} for ${id}.`);
    return String(values[name]);
  });
}

type ResultLike = { status: string; code?: string; message?: string; outcome?: Record<string, unknown> };

const ACTIONABLE_OPERATION_CODES = new Set(["access_unavailable", "protocol_mismatch", "restore_preview_stale", "target_capacity", "number_precision_exhausted", "number_unavailable", "number_adjusted", "restore_number_adjusted"]);

export function operationNeedsAttention(result: ResultLike) {
  if (ACTIONABLE_OPERATION_CODES.has(result.code ?? "")) return true;
  return (result.status === "invalid" || result.status === "not_applied") && !["assignment_changed", "selection_changed", "number_unavailable"].includes(result.code ?? "");
}

export function operationNotice(result: ResultLike, cueName = "This cue") {
  if (!operationNeedsAttention(result)) return null;
  const outcome = result.outcome ?? {};
  if (result.code === "number_precision_exhausted" || result.code === "number_unavailable") return result.message ?? "No free cue number fits within three decimal places. The cue is unnumbered.";
  if (result.code === "target_capacity") return syncNotice("N37", { cue: cueName });
  if (result.code === "protocol_mismatch") return syncNotice("N24");
  if (result.code === "access_unavailable") return syncNotice("N30");
  if (result.code === "number_adjusted") return syncNotice("N13", { requested: String(outcome.requested ?? "The requested number"), cue: cueName, assigned: String(outcome.number ?? "another number") });
  if (result.code === "restore_number_adjusted") return syncNotice("N18", { cue: cueName, requested: String(outcome.requested ?? "The old number"), assigned: String(outcome.number ?? "another number") });
  if (result.code === "position_changed") return syncNotice("N19");
  if (result.code === "restore_preview_stale") return syncNotice("N31");
  if (["selection_changed", "assignment_changed", "number_unavailable"].includes(result.code ?? "")) return syncNotice("N35", { specificReason: result.message ?? "the selected cues changed" });
  if (result.status === "invalid" || result.status === "not_applied") return syncNotice("N23", { specificReason: result.message ?? "the saved request needs review" });
  return null;
}
