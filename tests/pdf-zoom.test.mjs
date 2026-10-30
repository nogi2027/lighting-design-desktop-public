import test from "node:test";
import assert from "node:assert/strict";
import { getPdfZoomGeometry } from "../lib/pdf-zoom.ts";

test("compact note margin does not count as overflowing paper", () => {
  const options = { frameWidth:350, reservedWidth:150, pageWidth:360, pageOffset:72 };
  assert.equal(getPdfZoomGeometry({...options, requestedScale:1.5}).horizontallyScrollable, false);
  assert.equal(getPdfZoomGeometry({...options, requestedScale:2.1}).horizontallyScrollable, true);
});

test("keeps the existing default desktop scale", () => {
  const geometry = getPdfZoomGeometry({
    frameWidth: 1280,
    reservedWidth: 526,
    requestedScale: 1.35,
    pageWidth: 360,
  });

  assert.equal(geometry.fitScale, 2.0944444444444446);
  assert.equal(geometry.renderedScale, 1.35);
  assert.equal(geometry.horizontallyScrollable, false);
});

test("uses zoom as a multiplier when a phone must fit the page", () => {
  const fit = getPdfZoomGeometry({
    frameWidth: 390,
    reservedWidth: 159.6,
    requestedScale: 1.35,
    pageWidth: 360,
    pageOffset: 159.6,
  });
  const enlarged = getPdfZoomGeometry({
    frameWidth: 390,
    reservedWidth: 159.6,
    requestedScale: 2.1,
    pageWidth: 360,
    pageOffset: 159.6,
  });

  assert.ok(fit.renderedScale < 0.9, "the fitted phone scale is below the old minimum");
  assert.ok(enlarged.renderedScale > fit.renderedScale, "zoom in changes the rendered page size");
  assert.equal(fit.horizontallyScrollable, false);
  assert.equal(enlarged.horizontallyScrollable, true);
});

test("preserves the page fit boundary and reports overflow only after it is crossed", () => {
  const options = {
    frameWidth: 320,
    reservedWidth: 142.8,
    pageWidth: 360,
    pageOffset: 142.8,
  };
  const defaultGeometry = getPdfZoomGeometry({ ...options, requestedScale: 1.35 });
  const justFits = getPdfZoomGeometry({
    ...options,
    requestedScale: (320 - 142.8) / defaultGeometry.renderedScale / 360 * 1.35,
  });
  const enlarged = getPdfZoomGeometry({ ...options, requestedScale: 2.1 });

  assert.ok(defaultGeometry.renderedScale * 360 + 72 <= 320 + 0.5);
  assert.equal(justFits.horizontallyScrollable, false);
  assert.equal(enlarged.horizontallyScrollable, true);
});
