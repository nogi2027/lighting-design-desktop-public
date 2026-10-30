import type { Cue } from "./types.ts";

function isWordCharacter(value: string | undefined) {
  return !!value && /[\p{L}\p{N}'’‘]/u.test(value);
}

export function normalizeAnchorLine(value: string) {
  return value.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

export function snapSelectionToWords(selectedText: string, enclosingLine: string) {
  const selected = normalizeAnchorLine(selectedText);
  const line = normalizeAnchorLine(enclosingLine);
  if (!selected || !line) return selected;

  const searchableLine = line.toLocaleLowerCase().replace(/[’‘]/g, "'");
  const searchableSelection = selected.toLocaleLowerCase().replace(/[’‘]/g, "'");
  const matchIndex = searchableLine.indexOf(searchableSelection);
  if (matchIndex < 0) return selected.replace(/^[“”"\s]+|[“”"\s]+$/g, "");

  let start = matchIndex;
  let end = matchIndex + searchableSelection.length;
  while (start > 0 && isWordCharacter(line[start - 1])) start -= 1;
  while (end < line.length && isWordCharacter(line[end])) end += 1;
  return line.slice(start, end).replace(/^[“”"\s]+|[“”"\s]+$/g, "");
}

export function cleanCueAnchor(cue: Cue): Cue {
  const enclosingLine = normalizeAnchorLine(cue.enclosingLine);
  const isUnset = enclosingLine.toLowerCase().includes("set this cue's script anchor");
  if (isUnset) return { ...cue, enclosingLine };
  const selectedText = cue.anchorType === "line"
    ? enclosingLine
    : snapSelectionToWords(cue.selectedText, enclosingLine);
  return { ...cue, enclosingLine, selectedText: selectedText || enclosingLine };
}
