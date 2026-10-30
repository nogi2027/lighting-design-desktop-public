import test from "node:test";
import assert from "node:assert/strict";
import { cueMarkerLabel, cueMarkerMetrics, cueMarkerPosition, cueMarkerScaleForZoom } from "../lib/cue-marker.ts";

test("cue markers widen only when their displayed number needs more room", () => {
  assert.equal(cueMarkerLabel("LX 1.002"), "1.002");
  assert.equal(cueMarkerMetrics("LX 1").width, 15);
  assert.ok(cueMarkerMetrics("LX 1.002").width > 15);
  assert.ok(cueMarkerMetrics("LX 123456789012345").width <= 64);
});

test("word pills stay centered and line rectangles keep their right edge fixed", () => {
  const shortPhrase = cueMarkerPosition("phrase", "LX 1", 100, 80);
  const longPhrase = cueMarkerPosition("phrase", "LX 1.002", 100, 80);
  assert.equal(shortPhrase.centerX, 100);
  assert.equal(longPhrase.centerX, 100);

  const shortLine = cueMarkerPosition("line", "LX 1", 100, 80);
  const longLine = cueMarkerPosition("line", "LX 1.002", 100, 80);
  assert.equal(shortLine.left + shortLine.width, 97);
  assert.equal(longLine.left + longLine.width, 97);
});

test("cue markers apply half of the user's zoom change", () => {
  assert.equal(cueMarkerScaleForZoom(1), 1);
  assert.equal(cueMarkerScaleForZoom(1.5), 1.25);
  assert.equal(cueMarkerScaleForZoom(.67), .835);
  const base = cueMarkerMetrics("LX 1.002", 1);
  const zoomed = cueMarkerMetrics("LX 1.002", 1.25);
  const reduced = cueMarkerMetrics("LX 1.002", .835);
  assert.equal(zoomed.width, base.width * 1.25);
  assert.equal(zoomed.height, base.height * 1.25);
  assert.ok(Math.abs(reduced.height - 12.525) < .01);

  const phrase = cueMarkerPosition("phrase", "LX 1.002", 100, 80, 1.25);
  const line = cueMarkerPosition("line", "LX 1.002", 100, 80, 1.25);
  assert.equal(phrase.centerX, 100);
  assert.equal(line.left + line.width, 97);
});
