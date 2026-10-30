import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { operationNeedsAttention, operationNotice, SYNC_NOTICE_COPY, syncNotice } from "../lib/sync-v2/notifications.ts";

test("N01 through N37 match the approved notification catalogue", async () => {
  const specification = await readFile(new URL("../sync-v2-notifications.md", import.meta.url), "utf8");
  const rows = [...specification.matchAll(/^\| (N\d{2}) \|.*?\| “(.*?)” \|/gm)];
  assert.equal(rows.length, 37);
  assert.deepEqual(Object.keys(SYNC_NOTICE_COPY), Array.from({ length: 37 }, (_, index) => `N${String(index + 1).padStart(2, "0")}`));
  for (const [, id, copy] of rows) assert.equal(SYNC_NOTICE_COPY[id], copy, id);
});

test("notice interpolation uses supplied evidence and rejects guessed values", () => {
  assert.equal(syncNotice("N13", { requested: "LX 8", cue: "Hallway", assigned: "LX 8.1" }), "LX 8 was already in use. Hallway was assigned LX 8.1.");
  assert.throws(() => syncNotice("N04"), /Missing count for N04/);
});

test("only operation results that require a choice or repair raise notices", () => {
  assert.equal(operationNeedsAttention({ status: "adjusted", code: "saved_to_deleted_cue" }), false);
  assert.equal(operationNeedsAttention({ status: "adjusted", code: "bulk_assigned" }), false);
  assert.equal(operationNeedsAttention({ status: "retry_later", code: "server_busy" }), false);
  assert.equal(operationNotice({ status: "adjusted", code: "saved_to_deleted_cue" }), null);
  assert.equal(operationNotice({ status: "adjusted", code: "number_adjusted", outcome: { requested: "LX 4", number: "LX 4.1" } }, "Hallway"), "LX 4 was already in use. Hallway was assigned LX 4.1.");
  assert.equal(operationNotice({ status: "adjusted", code: "restore_number_adjusted", outcome: { requested: "LX 4", number: "LX 4.1" } }, "Hallway"), "Hallway was restored as LX 4.1; LX 4 is already in use.");
  assert.equal(operationNeedsAttention({ status: "not_applied", code: "selection_changed" }), false);
  assert.equal(operationNeedsAttention({ status: "not_applied", code: "protocol_mismatch" }), true);
});
