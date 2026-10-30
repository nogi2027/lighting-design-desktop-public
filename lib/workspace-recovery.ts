import { createWorkspacePatchMutation, isWorkspaceRecoveryMutation, mergeWorkspaceStates, rebaseWorkspaceRecoveryMutation, recordWorkspaceConflicts, type WorkspaceMutation, type WorkspaceRecoveryMutation, type WorkspaceSnapshot } from "./workspace-sync.ts";

export type RecoveryFailure = {
  mutationId: string;
  status?: number;
  message: string;
  retryable?: boolean;
};

type RecoverableMutation = WorkspaceMutation | WorkspaceRecoveryMutation;

type RecoveryResult = {
  status: number;
  snapshot: WorkspaceSnapshot;
  error?: string;
};

function isCompactMutation(value: RecoverableMutation): value is WorkspaceRecoveryMutation {
  return isWorkspaceRecoveryMutation(value);
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

/** Replay separately: one acknowledged ID must never cover another tab's work. */
export async function recoverWorkspace(
  initial: WorkspaceSnapshot,
  mutations: RecoverableMutation[],
  send: (mutation: ReturnType<typeof createWorkspacePatchMutation>) => Promise<RecoveryResult>,
  confirmed: (id: string) => void,
  failed?: (failure: RecoveryFailure) => void,
) {
  let snapshot = initial;
  const failures: RecoveryFailure[] = [];
  for (const original of mutations) {
    if (snapshot.recentMutationIds?.includes(original.mutationId)) {
      confirmed(original.mutationId);
      continue;
    }
    let base: WorkspaceSnapshot["state"];
    let next: WorkspaceSnapshot["state"];
    let revision: number;
    if (isCompactMutation(original)) {
      const rebased = rebaseWorkspaceRecoveryMutation(snapshot.state, original);
      base = snapshot.state;
      next = recordWorkspaceConflicts(rebased.state, rebased.conflicts, undefined, original.mutationId);
      revision = snapshot.revision;
    } else {
      base = original.base;
      next = original.next;
      revision = original.baseRevision;
    }
    let saved = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await send(createWorkspacePatchMutation(base, next, revision, original.mutationId));
      snapshot = result.snapshot;
      if (result.status === 200) { saved = true; break; }
      if (result.status !== 409) {
        const failure = { mutationId: original.mutationId, status: result.status, message: result.error ?? "Recovery could not save", retryable: isRetryableStatus(result.status) };
        failures.push(failure);
        failed?.(failure);
        break;
      }
      if (snapshot.recentMutationIds?.includes(original.mutationId)) { saved = true; break; }
      if (isCompactMutation(original)) {
        const rebased = rebaseWorkspaceRecoveryMutation(snapshot.state, original);
        next = recordWorkspaceConflicts(rebased.state, rebased.conflicts, undefined, original.mutationId);
      } else {
        const merged = mergeWorkspaceStates(base, next, snapshot.state);
        next = recordWorkspaceConflicts(merged.state, merged.conflicts, undefined, original.mutationId);
      }
      base = snapshot.state;
      revision = snapshot.revision;
    }
    if (!saved && failures.at(-1)?.mutationId === original.mutationId) continue;
    if (!saved) throw new Error("Recovery is waiting for other edits to finish");
    confirmed(original.mutationId);
  }
  if (failures.length) snapshot = { ...snapshot, recoveryFailures: failures };
  return snapshot;
}
