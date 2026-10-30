import { cueNumberSuffix } from "./cue-numbering.ts";
export type CueMarkerAnchorType = "line" | "phrase";

export function cueMarkerScaleForZoom(userZoom: number) {
  return 1 + .5 * (userZoom - 1);
}

export function cueMarkerLabel(number: number | string | null) {
  return cueNumberSuffix(number) || "—";
}

export function cueMarkerMetrics(number: number | string | null, markerScale = 1) {
  const characterCount = cueMarkerLabel(number).length;
  const baseFontSize = characterCount > 10 ? 4 : characterCount > 7 ? 4.5 : 5;
  const baseWidth = Math.min(64, Math.max(15, Math.ceil(characterCount * baseFontSize * .68 + 7)));
  const scaled = (value: number) => Math.round(value * markerScale * 100) / 100;
  return { width: scaled(baseWidth), height: scaled(15), fontSize: scaled(baseFontSize), markerScale };
}

export function cueMarkerPosition(anchorType: CueMarkerAnchorType, number: number | string | null, x: number, y: number, markerScale = 1) {
  const metrics = cueMarkerMetrics(number, markerScale);
  const left = anchorType === "line" ? Math.max(2, x - 3 - metrics.width) : Math.max(7, x - metrics.width / 2);
  const top = anchorType === "line" ? Math.max(2, y) : Math.max(3, y - 18);
  return { ...metrics, left, top, centerX: left + metrics.width / 2, centerY: top + metrics.height / 2 };
}
