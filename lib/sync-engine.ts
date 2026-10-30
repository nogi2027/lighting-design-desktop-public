export type SyncEngine = "v1" | "v2";

// Production builds default to Sync v2. A rollback build must opt into v1
// explicitly, which keeps an accidental missing environment value on v2.
export const ACTIVE_SYNC_ENGINE: SyncEngine = import.meta.env?.VITE_SYNC_ENGINE === "v1" ? "v1" : "v2";
