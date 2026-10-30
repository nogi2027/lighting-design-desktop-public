// Conditional requests use one head query when unchanged. Keep remote scene
// and cue changes within two seconds while retaining the 15s freshness gate.
export const SYNC_POLL_MS = 2_000;
export const VISIBLE_TEXT_POLL_MS = 1_000;
export const TEXT_SEND_IDLE_MS = 120;
export const TEXT_SEND_MAX_WAIT_MS = 300;
export const SYNC_FRESHNESS_MS = 15_000;
export const SYNC_PROBE_TIMEOUT_MS = 5_000;
export const SYNC_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export function retryDelay(attempt: number, random = Math.random) {
  const base = SYNC_RETRY_DELAYS_MS[Math.min(Math.max(0, attempt), SYNC_RETRY_DELAYS_MS.length - 1)];
  return Math.round(base * (0.85 + random() * 0.3));
}
