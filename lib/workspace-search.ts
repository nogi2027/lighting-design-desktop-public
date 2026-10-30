import { formatCueNumber } from "./cue-numbering.ts";
import { sceneAtPosition } from "./scene-boundaries.ts";
import { FIRST_SCRIPT_PDF_PAGE, scriptPageNumber } from "./script-page-number.ts";
import type { Cue, Discussion, Scene, WorkspaceState } from "./types.ts";

export type WorkspaceSearchKind = "cue" | "discussion" | "scene" | "script";
export type ScriptSearchPage = { page: number; text: string };

type SearchMetadata = { score: number; matchLabel: string; direct: boolean };
export type WorkspaceSearchResult = SearchMetadata & (
  | { kind: "cue"; cue: Cue }
  | { kind: "discussion"; discussion: Discussion; cue?: Cue; scene?: Scene }
  | { kind: "scene"; scene: Scene }
  | { kind: "script"; page: number; snippet: string }
);

export type WorkspaceSearchFilters = { kind: "all" | WorkspaceSearchKind; personId: "all" | string; sceneId: "all" | string };
type SearchField = { label: string; value: string; weight: number };
type SearchCandidate = { kind: WorkspaceSearchKind; key: string; position: number; fields: SearchField[]; directValue?: string; cue?: Cue; discussion?: Discussion; scene?: Scene; page?: number; scriptText?: string };
type ParsedSearchQuery = { normalized: string; tokens: string[]; intent?: WorkspaceSearchKind; directValue?: string };

export function normalizeSearchText(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function canonicalNumber(value: string) {
  const stripped = value.toLowerCase().replace(/^(?:cue|lx|scene|page|c|s|p)\s*#?\s*/, "").replace(/\s+/g, "");
  const match = stripped.match(/^(\d+)([a-z]?)(?:\.(\d+))?$/);
  if (!match) return stripped;
  if (!match[2]) return String(Number(stripped));
  return `${Number.parseInt(match[1], 10)}${match[2]}${match[3] === undefined ? "" : `.${match[3]}`}`;
}

export function parseWorkspaceSearchQuery(query: string): ParsedSearchQuery {
  const trimmed = query.trim().toLowerCase();
  const directPatterns: Array<{ kind: WorkspaceSearchKind; pattern: RegExp }> = [
    { kind: "cue", pattern: /^(?:cue|lx|c)\s*#?\s*(\d+(?:\.\d+)*)$/ },
    { kind: "script", pattern: /^(?:page|p)\s*#?\s*(\d+)$/ },
    { kind: "scene", pattern: /^(?:scene|s)\s*#?\s*(\d+[a-z]?)$/ },
  ];
  for (const entry of directPatterns) {
    const match = trimmed.match(entry.pattern);
    if (match) return { normalized: normalizeSearchText(match[1]), tokens: normalizeSearchText(match[1]).split(" "), intent: entry.kind, directValue: canonicalNumber(match[1]) };
  }
  if (/^\d+\.\d+$/.test(trimmed)) return { normalized: normalizeSearchText(trimmed), tokens: normalizeSearchText(trimmed).split(" "), intent: "cue", directValue: canonicalNumber(trimmed) };
  const intentMatch = trimmed.match(/^(cue|lx|scene|page|note|notes|script)\s+(.+)$/);
  const intent = intentMatch ? intentMatch[1] === "cue" || intentMatch[1] === "lx" ? "cue" : intentMatch[1] === "scene" ? "scene" : intentMatch[1] === "note" || intentMatch[1] === "notes" ? "discussion" : "script" : undefined;
  const normalized = normalizeSearchText(intentMatch?.[2] ?? trimmed);
  return { normalized, tokens: normalized ? normalized.split(" ") : [], intent };
}

function editDistance(left: string, right: string) {
  if (left === right) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(previous[rightIndex] + 1, current[rightIndex - 1] + 1, previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}

function fuzzyTokenScore(queryToken: string, fieldToken: string) {
  if (queryToken === fieldToken) return 500;
  if (queryToken.length >= 2 && fieldToken.startsWith(queryToken)) return 390;
  if (queryToken.length >= 3 && fieldToken.includes(queryToken)) return 300;
  if (queryToken.length < 3) return 0;
  const allowed = queryToken.length <= 4 ? 1 : queryToken.length <= 8 ? 2 : Math.floor(queryToken.length * .25);
  if (Math.abs(queryToken.length - fieldToken.length) > allowed) return 0;
  const distance = editDistance(queryToken, fieldToken);
  return distance <= allowed ? 210 + Math.round((1 - distance / Math.max(queryToken.length, fieldToken.length)) * 130) : 0;
}

function scoreField(field: SearchField, query: ParsedSearchQuery) {
  const normalizedField = normalizeSearchText(field.value);
  if (!normalizedField || !query.normalized) return 0;
  let base = normalizedField === query.normalized ? 1000 : normalizedField.startsWith(query.normalized) ? 820 : normalizedField.includes(query.normalized) ? 700 : 0;
  const fieldTokens = normalizedField.split(" ");
  let matchedTokens = 0;
  let tokenTotal = 0;
  query.tokens.forEach((queryToken) => {
    const best = fieldTokens.reduce((score, fieldToken) => Math.max(score, fuzzyTokenScore(queryToken, fieldToken)), 0);
    if (best > 0) matchedTokens += 1;
    tokenTotal += best;
  });
  if (matchedTokens > 0) {
    const coverage = matchedTokens / Math.max(1, query.tokens.length);
    base = Math.max(base, tokenTotal / Math.max(1, query.tokens.length) * coverage * coverage + (coverage === 1 ? 100 : 0));
  }
  return Math.round(base * field.weight);
}

function buildCandidates(state: WorkspaceState, scriptPages: ScriptSearchPage[]) {
  const candidates: SearchCandidate[] = [];
  const profiles = new Map(state.profiles.map((profile) => [profile.id, profile]));
  state.cues.forEach((cue) => {
    const directValue = cue.number ? canonicalNumber(String(cue.number)) : undefined;
    const owner = cue.ownerId ? profiles.get(cue.ownerId) : undefined;
    candidates.push({ kind: "cue", key: `cue:${cue.id}`, position: cue.page + (cue.anchorY ?? 0), cue, directValue, fields: [
      { label: "Cue number", value: cue.number ? `${formatCueNumber(cue.number)} cue ${directValue}` : "unassigned cue", weight: 5 },
      { label: "Title", value: cue.title, weight: 4 },
      { label: "Script line", value: `${cue.selectedText ?? ""} ${cue.enclosingLine ?? ""}`, weight: 3 },
      { label: "Description", value: cue.description, weight: 2 },
      { label: "Technical notes", value: cue.technicalNotes, weight: 1.5 },
      { label: "Owner", value: owner ? `${owner.name} ${owner.role}` : "", weight: 1 },
    ] });
  });
  state.scenes.forEach((scene) => {
    const owner = scene.ownerId ? profiles.get(scene.ownerId) : undefined;
    const directValue = canonicalNumber(scene.number);
    candidates.push({ kind: "scene", key: `scene:${scene.id}`, position: scene.pageStart + scene.startY, scene, directValue, fields: [
      { label: "Scene number", value: `scene ${scene.number} ${directValue}`, weight: 5 },
      { label: "Title", value: scene.name, weight: 4 },
      { label: "Owner", value: owner ? `${owner.name} ${owner.role}` : "", weight: 1 },
    ] });
  });
  state.discussions.forEach((discussion) => {
    const cue = discussion.cueId ? state.cues.find((item) => item.id === discussion.cueId) : undefined;
    const scene = discussion.sceneId ? state.scenes.find((item) => item.id === discussion.sceneId) : undefined;
    if (!cue && !scene && discussion.targetType !== "script") return;
    const author = profiles.get(discussion.authorId);
    const replies = discussion.replies.map((reply) => `${profiles.get(reply.authorId)?.name ?? ""} ${reply.content}`).join(" ");
    candidates.push({ kind: "discussion", key: `discussion:${discussion.id}`, position: cue?.page ?? scene?.pageStart ?? discussion.page ?? Number.MAX_SAFE_INTEGER, discussion, cue, scene, fields: [
      { label: "Note", value: discussion.content, weight: 2.5 },
      { label: "Attached item", value: `${cue?.number ?? ""} ${cue?.title ?? ""} ${scene?.number ?? ""} ${scene?.name ?? ""}`, weight: 2 },
      { label: "Script line", value: `${discussion.selectedText ?? ""} ${discussion.enclosingLine ?? ""}`, weight: 2 },
      { label: "Replies", value: replies, weight: 1.5 },
      { label: "Author", value: author ? `${author.name} ${author.role}` : "", weight: 1 },
    ] });
  });
  const scriptByPage = new Map(scriptPages.map((page) => [page.page, page.text]));
  for (let page = FIRST_SCRIPT_PDF_PAGE; page <= state.document.pages; page += 1) {
    const text = scriptByPage.get(page) ?? "";
    const printedPage = scriptPageNumber(page);
    candidates.push({ kind: "script", key: `script:${page}`, position: page, page, scriptText: text, directValue: String(printedPage), fields: [
      { label: "Page number", value: `page ${printedPage}`, weight: 5 },
      { label: "Script text", value: text, weight: 1.25 },
    ] });
  }
  return candidates;
}

function snippetFor(text: string, query: ParsedSearchQuery) {
  if (!text) return "Open script page";
  const lowered = text.toLowerCase();
  const needle = query.normalized || query.tokens[0] || "";
  let index = needle ? lowered.indexOf(needle) : -1;
  if (index < 0) index = query.tokens.map((token) => lowered.indexOf(token)).find((candidate) => candidate >= 0) ?? 0;
  const start = Math.max(0, index - 48);
  const end = Math.min(text.length, index + Math.max(needle.length, 1) + 82);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function resultPosition(result: WorkspaceSearchResult) {
  if (result.kind === "cue") return result.cue.page + (result.cue.anchorY ?? 0);
  if (result.kind === "scene") return result.scene.pageStart + result.scene.startY;
  if (result.kind === "discussion") return result.cue?.page ?? result.scene?.pageStart ?? result.discussion.page ?? Number.MAX_SAFE_INTEGER;
  return result.page;
}

function resultKey(result: WorkspaceSearchResult) {
  if (result.kind === "cue") return `cue:${result.cue.id}`;
  if (result.kind === "scene") return `scene:${result.scene.id}`;
  if (result.kind === "discussion") return `discussion:${result.discussion.id}`;
  return `script:${result.page}`;
}

function resultFromCandidate(candidate: SearchCandidate, score: number, matchLabel: string, direct: boolean, query: ParsedSearchQuery): WorkspaceSearchResult {
  const metadata = { score, matchLabel, direct };
  if (candidate.kind === "cue" && candidate.cue) return { ...metadata, kind: "cue", cue: candidate.cue };
  if (candidate.kind === "scene" && candidate.scene) return { ...metadata, kind: "scene", scene: candidate.scene };
  if (candidate.kind === "discussion" && candidate.discussion) return { ...metadata, kind: "discussion", discussion: candidate.discussion, cue: candidate.cue, scene: candidate.scene };
  return { ...metadata, kind: "script", page: candidate.page!, snippet: snippetFor(candidate.scriptText ?? "", query) };
}

export function searchWorkspace(state: WorkspaceState, scriptPages: ScriptSearchPage[], queryText: string) {
  const query = parseWorkspaceSearchQuery(queryText);
  if (!query.normalized) return [];
  return buildCandidates(state, scriptPages).flatMap((candidate) => {
    if (query.intent && candidate.kind !== query.intent) return [];
    const direct = !!query.directValue && candidate.directValue === query.directValue;
    let bestScore = 0;
    let matchLabel = "Match";
    candidate.fields.forEach((field) => {
      const score = scoreField(field, query);
      if (score > bestScore) { bestScore = score; matchLabel = field.label; }
    });
    if (direct) { bestScore += 100_000; matchLabel = candidate.kind === "cue" ? "Exact cue" : candidate.kind === "scene" ? "Exact scene" : "Exact page"; }
    return bestScore < 220 ? [] : [resultFromCandidate(candidate, bestScore, matchLabel, direct, query)];
  }).sort((left, right) => right.score - left.score || Number(right.direct) - Number(left.direct) || resultPosition(left) - resultPosition(right) || resultKey(left).localeCompare(resultKey(right)));
}

function resultSceneId(result: WorkspaceSearchResult, state: WorkspaceState) {
  if (result.kind === "scene") return result.scene.id;
  if (result.kind === "cue") return sceneAtPosition(state.scenes, result.cue.page, result.cue.anchorY ?? 0)?.id ?? null;
  if (result.kind === "discussion") {
    if (result.cue) return sceneAtPosition(state.scenes, result.cue.page, result.cue.anchorY ?? 0)?.id ?? null;
    if (result.scene) return result.scene.id;
    return result.discussion.page ? sceneAtPosition(state.scenes, result.discussion.page, result.discussion.anchorY ?? 0)?.id ?? null : null;
  }
  return sceneAtPosition(state.scenes, result.page, .5)?.id ?? null;
}

function resultPersonIds(result: WorkspaceSearchResult) {
  if (result.kind === "cue") return result.cue.ownerId ? [result.cue.ownerId] : [];
  if (result.kind === "scene") return result.scene.ownerId ? [result.scene.ownerId] : [];
  if (result.kind === "discussion") return [...new Set([result.discussion.authorId, ...result.discussion.replies.map((reply) => reply.authorId), result.cue?.ownerId, result.scene?.ownerId].filter((id): id is string => !!id))];
  return [];
}

export function filterWorkspaceSearchResults(results: WorkspaceSearchResult[], state: WorkspaceState, filters: WorkspaceSearchFilters) {
  return results.filter((result) => filters.kind !== "all" && result.kind !== filters.kind ? false : filters.personId !== "all" && !resultPersonIds(result).includes(filters.personId) ? false : filters.sceneId === "all" || resultSceneId(result, state) === filters.sceneId);
}

export function limitQuickSearchResults(results: WorkspaceSearchResult[], limit = 8, perKind = 3) {
  const counts = new Map<WorkspaceSearchKind, number>();
  return results.filter((result) => {
    const count = counts.get(result.kind) ?? 0;
    if (!result.direct && count >= perKind) return false;
    counts.set(result.kind, count + 1);
    return true;
  }).slice(0, limit);
}

export function paginateWorkspaceSearchResults(results: WorkspaceSearchResult[], page: number, perPage = 20) {
  const pageCount = Math.max(1, Math.ceil(results.length / perPage));
  const currentPage = Math.max(1, Math.min(pageCount, page));
  return { page: currentPage, pageCount, results: results.slice((currentPage - 1) * perPage, currentPage * perPage) };
}
