import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { encodeShow, decodeShow, sha256 } from "../lib/show-format.mjs";
import { validateShow } from "../lib/show-validation.mjs";
import { planCueNumberAssignments } from "../lib/cue-numbering.ts";
import { sceneAtPosition } from "../lib/scene-boundaries.ts";
function fixture() {
  const pdf = strToU8("%PDF-1.7\nfixture");
  const state = {
    schemaVersion: 1,
    id: "show",
    title: "Test show",
    document: {
      id: "script",
      filename: "test.pdf",
      version: sha256(pdf),
      pages: 2,
      firstPage: 1,
    },
    scenes: [
      {
        id: "scene",
        number: "1",
        name: "Opening",
        pageStart: 1,
        startY: 0,
        pageEnd: 2,
      },
    ],
    cues: [],
    discussions: [],
    deletedCues: [],
  };
  const reading = {
    sourceSha256: state.document.version,
    pages: [
      { pdfPage: 1, scriptPage: 1, width: 612, height: 792 },
      { pdfPage: 2, scriptPage: 2, width: 792, height: 612 },
    ],
    lines: [
      {
        id: "line",
        pdfPage: 1,
        text: "A test line",
        bbox: [30, 40, 150, 60],
        words: [{ start: 0, end: 1, bbox: [30, 40, 40, 60] }],
        runs: [{ start: 0, end: 11, style: "normal" }],
      },
    ],
    items: [
      {
        id: "node",
        kind: "turn",
        name: "",
        speaker: [],
        parts: [
          { kind: "dialogue", sources: [{ line: "line", start: 0, end: 11 }] },
        ],
      },
    ],
  };
  return { pdf, state, reading };
}
test("portable show round trip preserves original PDF, page geometry, and notes", () => {
  const f = fixture();
  f.state.discussions.push({
    id: "note",
    targetType: "script",
    page: 1,
    content: "Focus here",
    createdAt: new Date().toISOString(),
    resolved: false,
    replies: [],
  });
  const loaded = decodeShow(encodeShow(f));
  assert.deepEqual(loaded.state, f.state);
  assert.deepEqual(loaded.pdf, f.pdf);
  assert.deepEqual(loaded.reading, f.reading);
});
test("tampered and missing entries are rejected", () => {
  const files = unzipSync(encodeShow(fixture()));
  files["show.json"] = strToU8("{}");
  assert.throws(() => decodeShow(zipSync(files)), /integrity/);
  delete files["reading.json"];
  assert.throws(() => decodeShow(zipSync(files)), /incomplete/);
});
test("archive traversal entries and newer versions are rejected", () => {
  const files = unzipSync(encodeShow(fixture()));
  files["../outside"] = strToU8("bad");
  assert.throws(() => decodeShow(zipSync(files)), /entry/);
  const state = fixture().state;
  state.schemaVersion = 2;
  assert.throws(() => validateShow(state), /unsupported format/);
});
test("wrong script identity and invalid source references cannot be saved", () => {
  const f = fixture();
  f.reading.sourceSha256 = "0".repeat(64);
  assert.throws(() => encodeShow(f), /identity/);
  f.reading.sourceSha256 = f.state.document.version;
  f.reading.items[0].parts[0].sources[0].line = "absent";
  assert.throws(() => encodeShow(f), /nodes/);
});
test("scoped numbering preserves existing values and unselected scenes", () => {
  const cue = (id, number, page, sceneId) => ({
    id,
    number,
    page,
    sceneId,
    anchorOrder: page,
    anchorX: 0.2,
    anchorY: 0.3,
    anchorType: "line",
    enclosingLine: id,
    selectedText: id,
    title: id,
    description: "",
    technicalNotes: "",
    blackout: false,
    mode: number === null ? "unassigned" : "implemented",
  });
  const cues = [
    cue("existing", 10, 1, "a"),
    cue("selected", null, 2, "a"),
    cue("other", null, 3, "b"),
  ];
  const plan = planCueNumberAssignments(cues, new Set(["selected"]));
  assert.equal(plan.failedCueId, null);
  assert.equal(plan.cues.find((c) => c.id === "existing").number, 10);
  assert.equal(plan.cues.find((c) => c.id === "existing").mode, "implemented");
  assert.equal(plan.cues.find((c) => c.id === "other").number, null);
  assert.ok(plan.cues.find((c) => c.id === "selected").number > 10);
});
test("same-page scene boundaries use position rather than page alone", () => {
  const scenes = [
    { id: "a", pageStart: 1, startY: 0 },
    { id: "b", pageStart: 1, startY: 0.6 },
  ];
  assert.equal(sceneAtPosition(scenes, 1, 0.5).id, "a");
  assert.equal(sceneAtPosition(scenes, 1, 0.7).id, "b");
  const f = fixture();
  f.state.scenes.push({ ...f.state.scenes[0], id: "second" });
  assert.throws(() => validateShow(f.state), /boundaries/);
});
