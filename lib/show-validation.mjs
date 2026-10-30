export const LIMITS = {
  pages: 1500,
  pdfBytes: 100 * 1024 * 1024,
  archiveBytes: 160 * 1024 * 1024,
  stateBytes: 12 * 1024 * 1024,
  readingBytes: 100 * 1024 * 1024,
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 300) =>
  typeof value === "string" && value.length <= max;
const id = (value) => text(value, 128) && /^[a-zA-Z0-9_-]+$/.test(value);
const number = (value, min, max) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;
const array = (value, max) => Array.isArray(value) && value.length <= max;
const unique = (items) =>
  items.every((item) => object(item) && id(item.id)) &&
  new Set(items.map((item) => item.id)).size === items.length;
function requireValue(ok, message) {
  if (!ok) throw new Error(`Invalid show: ${message}`);
}
export function validateShow(state) {
  requireValue(
    object(state) && state.schemaVersion === 1,
    "unsupported format version. Use the version of Lighting Design Desktop that created this file.",
  );
  requireValue(
    id(state.id) && text(state.title) && state.title.trim(),
    "missing title or show ID",
  );
  const doc = state.document;
  requireValue(
    object(doc) &&
      id(doc.id) &&
      text(doc.filename) &&
      /^[a-f0-9]{64}$/.test(doc.version),
    "script metadata",
  );
  requireValue(
    Number.isInteger(doc.pages) &&
      number(doc.pages, 1, LIMITS.pages) &&
      Number.isInteger(doc.firstPage) &&
      number(doc.firstPage, 1, doc.pages),
    "page range",
  );
  for (const key of ["scenes", "cues", "discussions", "deletedCues"])
    requireValue(
      array(state[key], 50000) && unique(state[key]),
      `${key} collection`,
    );
  requireValue(
    state.scenes.length > 0 && state.scenes.length <= 3000,
    "at least one scene is required",
  );
  const page = (value) =>
    Number.isInteger(value) && number(value, 1, doc.pages);
  let previous = -1;
  for (const scene of state.scenes) {
    const position = scene.pageStart - 1 + scene.startY;
    requireValue(
      text(scene.number, 30) &&
        text(scene.name) &&
        page(scene.pageStart) &&
        page(scene.pageEnd) &&
        scene.pageEnd >= scene.pageStart &&
        number(scene.startY, 0, 0.999999) &&
        position > previous,
      "scene boundaries must be in script order, with no duplicate starts",
    );
    previous = position;
  }
  const scenes = new Set(state.scenes.map((s) => s.id));
  const cueIds = new Set(state.cues.map((c) => c.id));
  const validCue = (cue) => {
    requireValue(
      object(cue) &&
        id(cue.id) &&
        text(cue.title) &&
        text(cue.description, 20000) &&
        text(cue.technicalNotes, 20000),
      "cue text",
    );
    requireValue(
      scenes.has(cue.sceneId) &&
        page(cue.page) &&
        ["line", "phrase"].includes(cue.anchorType) &&
        number(cue.anchorOrder, 0, 1e15),
      "cue anchor",
    );
    requireValue(
      ["unassigned", "planned", "implemented"].includes(cue.mode) &&
        typeof cue.blackout === "boolean",
      "cue state",
    );
    requireValue(
      cue.number === null
        ? cue.mode === "unassigned"
        : number(cue.number, 0.001, 9e12) &&
            Number.isSafeInteger(Math.round(cue.number * 1000)) &&
            Math.round(cue.number * 1000) / 1000 === cue.number &&
            cue.mode !== "unassigned",
      "cue number",
    );
    requireValue(
      text(cue.selectedText, 20000) &&
        text(cue.enclosingLine, 20000) &&
        (cue.anchorX === undefined || number(cue.anchorX, 0, 1)) &&
        (cue.anchorY === undefined || number(cue.anchorY, 0, 1)),
      "cue coordinates",
    );
  };
  for (const cue of state.cues) validCue(cue);
  const assigned = state.cues
    .filter((c) => c.number !== null)
    .map((c) => c.number);
  requireValue(
    new Set(assigned).size === assigned.length,
    "duplicate cue numbers",
  );
  const validNote = (note, deletedId) => {
    requireValue(
      object(note) &&
        id(note.id) &&
        text(note.content, 20000) &&
        typeof note.resolved === "boolean" &&
        Number.isFinite(Date.parse(note.createdAt)),
      "note",
    );
    requireValue(
      ["cue", "scene", "script"].includes(note.targetType),
      "note target",
    );
    requireValue(
      note.targetType === "cue"
        ? cueIds.has(note.cueId) || note.cueId === deletedId
        : note.targetType === "scene"
          ? scenes.has(note.sceneId)
          : page(note.page),
      "note reference",
    );
    requireValue(
      (note.anchorX === undefined || number(note.anchorX, 0, 1)) &&
        (note.anchorY === undefined || number(note.anchorY, 0, 1)),
      "note coordinates",
    );
    requireValue(
      array(note.replies, 10000) &&
        unique(note.replies) &&
        note.replies.every(
          (reply) =>
            text(reply.content, 20000) &&
            Number.isFinite(Date.parse(reply.createdAt)),
        ),
      "note updates",
    );
  };
  for (const note of state.discussions) validNote(note);
  for (const deleted of state.deletedCues) {
    requireValue(
      object(deleted.cue) &&
        deleted.id === deleted.cue.id &&
        !cueIds.has(deleted.id) &&
        Number.isFinite(Date.parse(deleted.deletedAt)) &&
        array(deleted.discussions, 10000),
      "deleted cue",
    );
    validCue(deleted.cue);
    deleted.discussions.forEach((note) => validNote(note, deleted.id));
  }
  requireValue(
    !("profiles" in state) && !("conflicts" in state),
    "team data is unsupported",
  );
  return state;
}
export function validateReading(reading, state) {
  requireValue(
    object(reading) &&
      reading.sourceSha256 === state.document.version &&
      array(reading.pages, LIMITS.pages) &&
      reading.pages.length === state.document.pages,
    "script extraction identity",
  );
  requireValue(
    reading.pages.every(
      (p, i) =>
        object(p) &&
        p.pdfPage === i + 1 &&
        number(p.width, 1, 20000) &&
        number(p.height, 1, 20000) &&
        Number.isInteger(p.scriptPage),
    ),
    "script page geometry",
  );
  requireValue(
    array(reading.lines, 500000) &&
      unique(reading.lines) &&
      array(reading.items, 500000),
    "script extraction",
  );
  const box = (value, p) =>
    array(value, 4) &&
    value.length === 4 &&
    value.every((v) => number(v, -20000, 40000)) &&
    value[2] >= value[0] &&
    value[3] >= value[1] &&
    !!p;
  const ids = new Map();
  for (const line of reading.lines) {
    const p = reading.pages[line.pdfPage - 1];
    requireValue(
      object(line) &&
        p &&
        text(line.text, 20000) &&
        box(line.bbox, p) &&
        array(line.words, 10000) &&
        array(line.runs, 10000),
      "script line",
    );
    requireValue(
      line.words.every(
        (w) =>
          object(w) &&
          Number.isInteger(w.start) &&
          Number.isInteger(w.end) &&
          w.start >= 0 &&
          w.end <= line.text.length &&
          w.start < w.end &&
          box(w.bbox, p),
      ),
      "script words",
    );
    requireValue(
      line.runs.every(
        (r) =>
          object(r) &&
          Number.isInteger(r.start) &&
          Number.isInteger(r.end) &&
          r.start >= 0 &&
          r.end <= line.text.length &&
          r.end >= r.start &&
          ["normal", "italic", "bold"].includes(r.style) &&
          (r.bold === undefined || typeof r.bold === "boolean") &&
          (r.italic === undefined || typeof r.italic === "boolean") &&
          (r.size === undefined || number(r.size, .1, 20)) &&
          (r.fontFamily === undefined || ["serif","sans-serif","monospace"].includes(r.fontFamily)) &&
          [r.color,r.highlight].every(c=>c === undefined || /^#[a-f0-9]{6}$/i.test(c)),
      ),
      "script styles",
    );
    requireValue(line.layout === undefined || (object(line.layout) && number(line.layout.indent,0,1) && number(line.layout.gap,0,1500)), "script layout");
    ids.set(line.id, line);
  }
  let nodes = 0;
  const sources = (list) =>
    array(list, 10000) &&
    list.every(
      (s) =>
        object(s) &&
        ids.has(s.line) &&
        Number.isInteger(s.start) &&
        Number.isInteger(s.end) &&
        s.start >= 0 &&
        s.end <= ids.get(s.line).text.length &&
        s.end >= s.start,
    );
  const node = (item, depth = 0) => {
    if (++nodes > 500000 || depth > 3 || !object(item) || !id(item.id))
      return false;
    if (item.kind === "parallel")
      return (
        array(item.columns, 10) &&
        item.columns.every(
          (c) => array(c, 10000) && c.every((n) => node(n, depth + 1)),
        )
      );
    if (["heading", "music", "direction", "layout"].includes(item.kind))
      return sources(item.sources);
    return (
      item.kind === "turn" &&
      text(item.name ?? "") &&
      sources(item.speaker) &&
      array(item.parts, 10000) &&
      item.parts.every(
        (p) =>
          ["dialogue", "direction", "lyric"].includes(p.kind) &&
          sources(p.sources),
      )
    );
  };
  requireValue(
    reading.items.every((item) => node(item)),
    "formatted script nodes",
  );
  return reading;
}
