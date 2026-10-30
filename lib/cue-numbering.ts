import type { Cue } from "./types.ts";
import { CUE_NUMBER_SUFFIX_LIMIT } from "./field-limits.ts";

type Placement = Pick<Cue, "page" | "anchorX" | "anchorY" | "anchorOrder"> & Partial<Pick<Cue, "id" | "anchorType" | "enclosingLine">>;

const SAME_LINE_TOLERANCE = .012;
const POSITION_ONLY_LINE_TOLERANCE = .006;

export const CUE_NUMBER_DECIMAL_PLACES = 3;
const CUE_NUMBER_SCALE = 1_000;
export const MAX_CUE_NUMBER = Math.floor(Number.MAX_SAFE_INTEGER / CUE_NUMBER_SCALE);
export const NUMBER_SPACE_ERROR = "No free cue number fits within three decimal places. This cue was left unnumbered.";

/** Read old prefixed records at the boundary without rounding existing values. */
export function readCueNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (value == null || value === "") return null;
  const suffix = typeof value === "string" ? value.replace(/^LX\s*/i, "").trim() : String(value);
  if (!/^\d+(?:\.\d+)?$/.test(suffix)) return null;
  const number = Number(suffix);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function isValidCueNumber(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_CUE_NUMBER) return false;
  const units = Math.round(value * CUE_NUMBER_SCALE);
  return Number.isSafeInteger(units) && units / CUE_NUMBER_SCALE === value;
}

export function parseCueNumber(value: unknown): number | null {
  if (typeof value === "number") return isValidCueNumber(value) ? value : null;
  if (typeof value !== "string") return null;
  const suffix = value.replace(/^LX\s*/i, "").trim();
  if (suffix.length > CUE_NUMBER_SUFFIX_LIMIT || !/^\d+(?:\.\d{1,3})?$/.test(suffix)) return null;
  const number = Number(suffix);
  const [whole, fraction = ""] = suffix.split(".");
  const units = Number(whole) * CUE_NUMBER_SCALE + Number(fraction.padEnd(CUE_NUMBER_DECIMAL_PLACES, "0"));
  return isValidCueNumber(number) && Math.round(number * CUE_NUMBER_SCALE) === units ? number : null;
}

export function formatCueNumber(value: unknown, unassigned = "UNASSIGNED") {
  const suffix = cueNumberSuffix(value);
  return suffix ? `LX ${suffix}` : unassigned;
}

export function cueNumberSuffix(value: unknown) {
  const number = readCueNumber(value);
  if (number === null) return "";
  const [coefficient, exponent] = String(number).split("e");
  if (exponent === undefined) return coefficient;
  // Legacy readers require decimal digits, including values below 0.000001.
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function sanitizeCueSuffix(value: string) {
  const cleaned = value.replace(/[^\d.]/g, "");
  const [whole, ...fraction] = cleaned.split(".");
  if (fraction.length === 0) return whole;
  return `${whole || "0"}.${fraction.join("")}`;
}

export function isValidCueSuffix(value: string) {
  return parseCueNumber(value) !== null;
}

export function isCueAssignmentValid(number: number | null, mode: Cue["mode"]) {
  return number === null ? mode === "unassigned" : mode !== "unassigned";
}

export function normalizeCueNumbers(state: import("./types.ts").WorkspaceState) {
  return {
    ...state,
    cues: state.cues.map((cue) => ({ ...cue, number: readCueNumber(cue.number) })),
    deletedCues: state.deletedCues.map((item) => ({ ...item, cue: { ...item.cue, number: readCueNumber(item.cue.number) } })),
  };
}

function placementY(item: Placement) {
  return item.anchorY ?? Math.min(.99, Math.max(.01, item.anchorOrder / 1000));
}

function normalizedLine(item: Placement) {
  return item.enclosingLine?.replace(/\s+/g, " ").trim().toLocaleLowerCase() ?? "";
}

function compareWithinLine(a: Placement, b: Placement) {
  const anchorTypeOrder = (a.anchorType === "line" ? 0 : 1) - (b.anchorType === "line" ? 0 : 1);
  return anchorTypeOrder
    || (a.anchorX ?? 0) - (b.anchorX ?? 0)
    || a.anchorOrder - b.anchorOrder
    || (a.id ?? "").localeCompare(b.id ?? "");
}

export function orderCuePlacements<T extends Placement>(placements: readonly T[]) {
  const indexed = placements.map((placement, index) => ({ placement, index }));
  const pages = new Map<number, typeof indexed>();
  indexed.forEach((entry) => pages.set(entry.placement.page, [...(pages.get(entry.placement.page) ?? []), entry]));

  return [...pages.entries()].sort(([left], [right]) => left - right).flatMap(([, entries]) => {
    const groups: Array<{ y: number; line: string; entries: typeof indexed }> = [];
    [...entries].sort((left, right) => placementY(left.placement) - placementY(right.placement) || left.index - right.index).forEach((entry) => {
      const y = placementY(entry.placement);
      const line = normalizedLine(entry.placement);
      const group = groups.findLast((candidate) => {
        const distance = Math.abs(candidate.y - y);
        return line && candidate.line ? line === candidate.line && distance <= SAME_LINE_TOLERANCE : distance <= POSITION_ONLY_LINE_TOLERANCE;
      });
      if (group) group.entries.push(entry);
      else groups.push({ y, line, entries: [entry] });
    });
    return groups.flatMap((group) => group.entries.sort((left, right) => compareWithinLine(left.placement, right.placement) || left.index - right.index).map((entry) => entry.placement));
  });
}

export function compareCuePlacements(a: Placement, b: Placement) {
  const pageOrder = a.page - b.page;
  if (pageOrder) return pageOrder;
  const yOrder = placementY(a) - placementY(b);
  const sameNamedLine = normalizedLine(a) && normalizedLine(a) === normalizedLine(b) && Math.abs(yOrder) <= SAME_LINE_TOLERANCE;
  if (!sameNamedLine && yOrder) return yOrder;
  return compareWithinLine(a, b);
}

export function sortCuesByPosition(cues: Cue[]) {
  return orderCuePlacements(cues).map((cue, index) => ({ ...cue, anchorOrder: index + 1 }));
}

export function findOutOfOrderCueIds(cues: Cue[]) {
  const ordered = orderCuePlacements(cues).filter((cue) => readCueNumber(cue.number) !== null);
  const ids = new Set<string>();
  for (let index = 1; index < ordered.length; index += 1) {
    if (readCueNumber(ordered[index - 1].number)! >= readCueNumber(ordered[index].number)!) {
      ids.add(ordered[index - 1].id);
      ids.add(ordered[index].id);
    }
  }
  return ids;
}

export function autoNumberForPlacement(cues: Cue[], placement: Placement): number | null {
  const numbered = cues.filter((cue) => (placement.id === undefined || cue.id !== placement.id) && readCueNumber(cue.number) !== null);
  const used = new Set(numbered.map((cue) => readCueNumber(cue.number)!));
  const ordered = orderCuePlacements([...numbered, placement]);
  const index = ordered.indexOf(placement);
  const previous = index > 0 ? readCueNumber((ordered[index - 1] as Cue).number)! : 0;
  const next = index < ordered.length - 1 ? readCueNumber((ordered[index + 1] as Cue).number)! : null;
  const available = (candidate: number) => isValidCueNumber(candidate) && candidate > previous && (next === null || candidate < next) && !used.has(candidate);
  if (next === null) {
    const candidate = Math.floor(Math.max(0, ...used)) + 1;
    return available(candidate) ? candidate : null;
  }
  if (previous >= next) return null;
  const units = isValidCueNumber(previous) ? Math.round(previous * CUE_NUMBER_SCALE) : Math.floor(previous * CUE_NUMBER_SCALE);
  // Prefer whole numbers in wide gaps, then tenths, hundredths and thousandths.
  const steps = Number.isInteger(previous) && next >= previous + 2 ? [1_000, 100, 10, 1] : [100, 10, 1];
  for (const step of steps) {
    const first = Math.floor(units / step) * step + step;
    // Each occupied candidate accounts for a used number, so this bound also
    // covers large gaps without walking every number in them.
    for (let attempt = 0; attempt <= used.size; attempt += 1) {
      const candidate = (first + attempt * step) / CUE_NUMBER_SCALE;
      if (candidate >= next || candidate > MAX_CUE_NUMBER) break;
      if (available(candidate)) return candidate;
    }
  }
  return null;
}

export type CueNumberAssignment = { cueId: string; number?: number; unchanged?: true };

/** Calculate the whole batch without changing the placement values used to order it. */
export function planCueNumberAssignments(cues: Cue[], selectedIds: ReadonlySet<string>) {
  let working = [...cues];
  const assignments: CueNumberAssignment[] = [];
  for (const cue of orderCuePlacements(cues.filter((item) => selectedIds.has(item.id)))) {
    if (cue.number) {
      assignments.push({ cueId: cue.id, unchanged: true });
      continue;
    }
    const number = autoNumberForPlacement(working, cue);
    if (number === null) return { cues, assignments: [] as CueNumberAssignment[], failedCueId: cue.id };
    working = working.map((item) => item.id === cue.id ? { ...item, number, mode: "planned" } : item);
    assignments.push({ cueId: cue.id, number });
  }
  return { cues: sortCuesByPosition(working), assignments, failedCueId: null };
}

export function assignUnnumberedCues(cues: Cue[], selectedIds?: ReadonlySet<string>) {
  return planCueNumberAssignments(cues, selectedIds ?? new Set(cues.filter((cue) => !cue.number).map((cue) => cue.id))).cues;
}

export function repairDuplicateCueNumbers(cues: Cue[]) {
  const seen = new Set<number>();
  const duplicateIds: string[] = [];
  sortCuesByPosition(cues).forEach((cue) => {
    const number = readCueNumber(cue.number);
    if (number == null) return;
    if (seen.has(number)) duplicateIds.push(cue.id);
    else seen.add(number);
  });
  if (duplicateIds.length === 0) return cues;

  const duplicates = new Set(duplicateIds);
  const originalModes = new Map(cues.map((cue) => [cue.id, cue.mode]));
  let repaired = cues.map((cue) => duplicates.has(cue.id) ? { ...cue, number: null, mode: "unassigned" as const } : cue);
  duplicateIds.forEach((cueId) => {
    const cue = repaired.find((item) => item.id === cueId);
    if (!cue) return;
    const number = autoNumberForPlacement(repaired.filter((item) => item.id !== cueId), cue);
    repaired = repaired.map((item) => item.id === cueId ? {
      ...item,
      number,
      mode: number === null ? "unassigned" : originalModes.get(cueId) === "implemented" ? "implemented" : "planned",
    } : item);
  });
  return sortCuesByPosition(repaired);
}

/** Keep existing Sync v2 readers and rollback exports compatible at the wire boundary. */
export function cueNumbersForTransport(state: import("./types.ts").WorkspaceState) {
  const encode = (cue: Cue) => ({ ...cue, number: cue.number === null ? null : formatCueNumber(cue.number) });
  return { ...state, cues: state.cues.map(encode), deletedCues: state.deletedCues.map((item) => ({ ...item, cue: encode(item.cue) })) };
}
