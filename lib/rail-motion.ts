export const GAP_CLOSE_SPEED = 120;
export const CARD_CLOSE_MS = 150;
export const NOTE_EXIT_DELAY_MS = 150;
export const LONG_OPEN_SPEED = 360;

export type RailCurve = { from: number; to: number; velocity: number; duration: number; started: number };

// Cubic Hermite motion: retain the incoming velocity, finish at rest.
export function sampleRailCurve(curve: RailCurve, now: number) {
  const u = Math.max(0, Math.min(1, (now - curve.started) / curve.duration));
  const distance = curve.to - curve.from;
  return {
    height: curve.from + distance * u * u * (3 - 2 * u) + curve.velocity * curve.duration * u * (1 - u) * (1 - u),
    velocity: (distance * 6 * u * (1 - u) + curve.velocity * curve.duration * (1 - 4 * u + 3 * u * u)) / curve.duration,
    finished: u === 1,
  };
}
