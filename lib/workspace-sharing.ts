import type { WorkspaceState } from "./types.ts";

/** Keep unchanged entities/collections stable when a JSON snapshot arrives. */
export function shareWorkspaceState(previous: WorkspaceState, incoming: WorkspaceState): WorkspaceState {
  const next = { ...incoming };
  let changed = Object.keys(previous).some((key) => !Object.hasOwn(incoming, key));
  for (const key of Object.keys(incoming) as Array<keyof WorkspaceState>) {
    const before = previous[key];
    const after = incoming[key];
    let shared: unknown = after;
    if (Array.isArray(before) && Array.isArray(after)) {
      const entities = new Map(before.map((item: { id: string }) => [item.id, item]));
      const values = after.map((item: { id: string }) => {
        const old = entities.get(item.id);
        return old && JSON.stringify(old) === JSON.stringify(item) ? old : item;
      });
      shared = values.length === before.length && values.every((item, index) => item === before[index]) ? before : values;
    } else if (JSON.stringify(before) === JSON.stringify(after)) shared = before;
    Object.assign(next, { [key]: shared });
    if (shared !== before) changed = true;
  }
  return changed ? next : previous;
}
