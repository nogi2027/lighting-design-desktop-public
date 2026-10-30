import type { SyncRecoveryItem, TextValues } from "./client-store.ts";

export const TEXT_FIELDS = ["title", "description", "technicalNotes"] as const;
type TextField = typeof TEXT_FIELDS[number];
export type SavedTextChoice = { itemId: string; actorId: string; createdAt: string; value: string };

export function textRecoveryPlan(items: SyncRecoveryItem[], server: TextValues, epoch: string) {
  const ordered = [...items].sort((left, right) => (left.createdAt ?? left.envelope?.createdAt ?? left.protectedAt ?? "").localeCompare(right.createdAt ?? right.envelope?.createdAt ?? right.protectedAt ?? ""));
  const complete = ordered.length > 0 && ordered.every((item) => item.textFallback && item.textFallback.epoch === epoch);
  if (!complete) return null;
  const before = ordered[0].textFallback!.before;
  const after = { ...before };
  const suggested = { ...server };
  const conflicts: TextField[] = [];
  const choices = {} as Record<TextField, SavedTextChoice[]>;
  for (const field of TEXT_FIELDS) {
    const changes = ordered.filter((item) => item.textFallback!.before[field] !== item.textFallback!.after[field]);
    if (!changes.length) { choices[field] = []; continue; }
    const base = changes[0].textFallback!.before[field];
    let value = base;
    let branched = false;
    for (const item of changes) {
      const change = item.textFallback!;
      if (change.before[field] === value) value = change.after[field];
      else if (change.after[field] !== value) branched = true;
    }
    const candidates = branched ? changes : [changes.at(-1)!];
    choices[field] = candidates.reduce<SavedTextChoice[]>((result, item) => {
      const value = item.textFallback!.after[field];
      if (!result.some((candidate) => candidate.value === value)) result.push({ itemId: item.id, actorId: item.textFallback!.actorId, createdAt: item.createdAt ?? item.envelope?.createdAt ?? item.protectedAt ?? "", value });
      return result;
    }, []);
    after[field] = branched ? changes.at(-1)!.textFallback!.after[field] : value;
    if (branched || server[field] !== base && server[field] !== value) conflicts.push(field);
    else suggested[field] = value;
  }
  return { before, after, suggested, conflicts, choices };
}
