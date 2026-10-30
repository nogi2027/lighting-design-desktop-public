import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Cue } from "./types";

export type Box = [number, number, number, number];
export type SourceSlice = { line: string; start: number; end: number };
export type SourceRun = { start: number; end: number; style: string; bold?: boolean; italic?: boolean; size?: number; fontFamily?: "serif" | "sans-serif" | "monospace"; color?: string; highlight?: string };
export type SourceLine = { id: string; pdfPage: number; text: string; bbox: Box; words: { start: number; end: number; bbox: Box }[]; runs: SourceRun[]; layout?: { indent: number; gap: number } };
export type ScriptNode = { id: string; kind: string; name?: string; speaker?: SourceSlice[]; parts?: { kind: string; sources: SourceSlice[] }[]; sources?: SourceSlice[]; columns?: ScriptNode[][] };
export type FormattedDocument = { sourceSha256: string; pages: { pdfPage: number; scriptPage: number; width: number; height: number; ocr?: boolean }[]; lines: SourceLine[]; items: ScriptNode[] };
export type ReadingOptions = { document: FormattedDocument; pages: boolean; font: "serif" | "sans" | "source"; size: number; leading: number; width: number };

const retained = new WeakMap<PDFDocumentProxy, Promise<FormattedDocument | null>>();
// Only use the reviewed extraction when it matches the actual R2 document.
// Unknown/replaced documents keep the original selectable PDF viewer.
export function loadFormattedDocument(pdf: PDFDocumentProxy) {
  let loading = retained.get(pdf);
  if (!loading) {
    loading = Promise.all([fetch("/script/reading.json").then(async response => {
      if (!response.ok) throw new Error("Formatted script unavailable");
      return await response.json() as FormattedDocument;
    }), pdf.getData()]).then(async ([document, bytes]) => {
      const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
      const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      return hash === document.sourceSha256 ? document : null;
    }).catch(() => null);
    retained.set(pdf, loading);
  }
  return loading;
}

export function sourceAnchor(document: FormattedDocument, lineId: string, first: number, last = first) {
  const line = document.lines.find(line => line.id === lineId);
  const page = document.pages.find(page => page.pdfPage === line?.pdfPage);
  if (!line || !page || !line.words[first] || !line.words[last]) return null;
  return { page: line.pdfPage, selectedText: line.text.slice(line.words[first].start, line.words[last].end), enclosingLine: line.text,
    anchorX: line.words[first].bbox[0] / page.width, anchorY: line.bbox[1] / page.height,
    lineAnchorX: line.bbox[0] / page.width, lineAnchorY: line.bbox[1] / page.height };
}

const normal = (value: string) => value.toLowerCase().normalize("NFKC").replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function resolveCueSource(document: FormattedDocument, cue: Pick<Cue, "page" | "anchorX" | "anchorY" | "selectedText" | "enclosingLine" | "anchorType">) {
  const page = document.pages.find(page => page.pdfPage === cue.page);
  if (!page) return null;
  const lines = document.lines.filter(line => line.pdfPage === cue.page);
  const selected = normal(cue.selectedText), enclosing = normal(cue.enclosingLine);
  if (!selected && !enclosing && (cue.anchorY == null || !(cue.selectedText.trim() || cue.enclosingLine.trim()))) return null;
  const lineScore = (line: SourceLine) => {
    const text = normal(line.text);
    const distance = cue.anchorY == null ? 0 : Math.abs(line.bbox[1] / page.height - cue.anchorY);
    const horizontal = cue.anchorX == null ? 0 : Math.max(0, line.bbox[0] / page.width - cue.anchorX, cue.anchorX - line.bbox[2] / page.width);
    // Geometry disambiguates repeated dialogue and simultaneous columns.
    return distance * 100 + horizontal * 20 + (enclosing && text === enclosing ? -1 : 0) + (selected && text.includes(selected) ? -.5 : 0);
  };
  const candidates = cue.anchorY == null ? lines.filter(line => normal(line.text).includes(selected) || normal(line.text) === enclosing) : lines;
  const line = [...candidates].sort((a, b) => lineScore(a) - lineScore(b))[0];
  if (!line) return null;
  let word = 0;
  if (cue.anchorType === "phrase") {
    const position = cue.anchorX == null ? -1 : cue.anchorX * page.width;
    word = line.words.reduce((best, item, index) => {
      const distance = position < 0 ? (selected.startsWith(normal(line.text.slice(item.start, item.end))) ? 0 : 1000 + index) : Math.abs(item.bbox[0] - position);
      return distance < best.distance ? { index, distance } : best;
    }, { index: 0, distance: Infinity }).index;
  }
  return { lineId: line.id, word, line };
}

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function renderScriptPage(document: FormattedDocument, pdfPage: number) {
  const voiceKeys = new Map<string, string>();
  let voiceKey = "", voiceCount = 0;
  for (const node of document.items) {
    if (node.kind !== "parallel") { voiceKey = ""; voiceCount = 0; continue; }
    if (!voiceKey || node.columns!.length !== voiceCount) { voiceKey = node.id; voiceCount = node.columns!.length; }
    voiceKeys.set(node.id, `${document.sourceSha256}-${voiceKey}`);
  }
  const lines = new Map(document.lines.map(line => [line.id, line]));
  const onPage = (sources: SourceSlice[]) => sources.filter(source => lines.get(source.line)?.pdfPage === pdfPage);
  const filter = (node: ScriptNode): ScriptNode | null => {
    if (node.kind === "parallel") {
      const columns = node.columns!.map(column => column.map(filter).filter((node): node is ScriptNode => !!node));
      return columns.some(column => column.length) ? { ...node, columns } : null;
    }
    if (node.kind !== "turn") { const sources = onPage(node.sources!); return sources.length ? { ...node, sources } : null; }
    const speaker = onPage(node.speaker!), parts = node.parts!.map(part => ({ ...part, sources: onPage(part.sources) })).filter(part => part.sources.length);
    return speaker.length || parts.length ? { ...node, speaker, parts } : null;
  };
  const styledText = (run: SourceRun, text: string) => {
    if (run.italic || run.style === "italic") text = `<em>${text}</em>`;
    if (run.bold || run.style === "bold") text = `<strong>${text}</strong>`;
    const css: string[] = [];
    if (Number.isFinite(run.size) && run.size! > 0 && Math.abs(run.size! - 1) > .06) css.push(`font-size:${Math.min(4,Math.max(.5,run.size!))}em`);
    if (run.fontFamily && ["serif","sans-serif","monospace"].includes(run.fontFamily)) css.push(`font-family:var(--reader-import-font,${run.fontFamily})`);
    if (/^#[a-f0-9]{6}$/i.test(run.color ?? "")) css.push(`color:${run.color}`);
    if (/^#[a-f0-9]{6}$/i.test(run.highlight ?? "")) css.push(`background-color:${run.highlight}${/^#[a-f0-9]{6}$/i.test(run.color ?? "") ? "" : ";color:#151515"}`);
    return css.length ? `<span style="${css.join(';')}">${text}</span>` : text;
  };
  const lineHTML = (slice: SourceSlice) => {
    const line = lines.get(slice.line)!;
    let result = "", cursor = slice.start;
    line.words.forEach((word, index) => {
      if (word.start < slice.start || word.end > slice.end) return;
      result += escape(line.text.slice(cursor, word.start));
      const text = line.runs.map(run => {
        const start = Math.max(run.start, word.start), end = Math.min(run.end, word.end);
        if (end <= start) return "";
        const text = escape(line.text.slice(start, end));
        return styledText(run, text);
      }).join("");
      result += `<span class="reader-word" data-source-line="${line.id}" data-source-word="${index}" data-source-y="${line.bbox[1] / (document.pages.find(page=>page.pdfPage===line.pdfPage)?.height || 576)}">${text}</span>`;
      cursor = word.end;
    });
    return `<span class="reader-source-line" data-line-id="${line.id}">${result}${escape(line.text.slice(cursor, slice.end))}</span>`;
  };
  const prose = (sources: SourceSlice[]) => sources.map((source, index) => `${index && !lines.get(sources[index - 1].line)!.text.trimEnd().endsWith("-") ? " " : ""}${lineHTML(source)}`).join("");
  const nodeHTML = (node: ScriptNode): string => {
    if (node.kind === "parallel") return flow([node]);
    if (node.kind === "layout") return `<section class="reader-layout"><div class="reader-turn-body">${node.sources!.map(source => {
      const layout = lines.get(source.line)!.layout;
      const indent = Number.isFinite(layout?.indent) ? Math.max(0, Math.min(.85, layout!.indent)) * 100 : 0;
      const gap = Number.isFinite(layout?.gap) ? Math.max(0, Math.min(30, layout!.gap)) : 0;
      return `<div class="reader-import-line" style="margin-left:${indent}%;margin-top:${gap}em">${lineHTML(source)}</div>`;
    }).join("")}</div></section>`;
    if (node.kind === "heading") return `<h2 class="reader-act">${prose(node.sources!)}</h2>`;
    if (node.kind === "music") return `<section class="reader-song"><h3>${prose(node.sources!)}</h3></section>`;
    if (node.kind === "direction") return `<aside class="reader-direction"><p>${prose(node.sources!)}</p></aside>`;
    const speaker = node.speaker!.length ? prose(node.speaker!) : escape(node.name || "");
    const content = node.parts!.map((part, index) => {
      const name = !index && speaker ? `<span class="reader-character">${speaker}</span> ` : "";
      if (part.kind === "lyric") return `${name ? `<p class="reader-lyric-speaker">${name}</p>` : ""}<div class="reader-verse">${part.sources.map(source => `<div class="reader-lyric-line">${lineHTML(source)}</div>`).join("")}</div>`;
      return `<p class="${part.kind === "direction" ? "reader-instruction" : "reader-dialogue"}">${name}${prose(part.sources)}</p>`;
    }).join("") || `<p class="reader-speaker-only"><span class="reader-character">${speaker}</span></p>`;
    return `<section class="reader-turn"><div class="reader-turn-body">${content}</div></section>`;
  };
  const flow = (nodes: ScriptNode[]): string => {
    let html = "";
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (node.kind !== "parallel") { html += nodeHTML(node); continue; }
      const count = node.columns!.length, run = [node];
      while (nodes[index + 1]?.kind === "parallel" && nodes[index + 1].columns!.length === count && voiceKeys.get(nodes[index + 1].id) === voiceKeys.get(node.id)) run.push(nodes[++index]);
      html += `<div class="reader-parallel-run" data-voices="${count}" data-voice-key="${voiceKeys.get(node.id)}"><div class="reader-voice-panels" tabindex="0" role="region" aria-label="Simultaneous voices. Swipe sideways or use left and right arrow keys."><div class="reader-swiping-columns" style="--voice-count:${count}">${Array.from({ length: count }, (_, voice) => `<div class="reader-voice-column" data-voice-index="${voice}">${run.flatMap(node => node.columns![voice]).map(nodeHTML).join("")}</div>`).join("")}</div></div></div>`;
    }
    return html;
  };
  return flow(document.items.map(filter).filter((node): node is ScriptNode => !!node));
}
