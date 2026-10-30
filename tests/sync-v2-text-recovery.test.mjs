import assert from "node:assert/strict";
import test from "node:test";
import { textRecoveryPlan } from "../lib/sync-v2/text-recovery.ts";

const base = { title: "Cue", description: "Blue", technicalNotes: "Fade 3" };
const first = { ...base, title: "Cue one" };
const final = { ...first, title: "Cue one!", technicalNotes: "Fade 5" };
const items = [
  { id: "a", createdAt: "2026-09-11T01:00:00Z", textFallback: { before: base, after: first, epoch: "epoch-a", actorId: "actor-a" } },
  { id: "b", createdAt: "2026-09-11T01:00:01Z", textFallback: { before: first, after: final, epoch: "epoch-a", actorId: "actor-a" } },
];

test("a text chain can repair fields the server has not changed", () => {
  const plan = textRecoveryPlan(items, { ...base, description: "Deep blue" }, "epoch-a");
  assert.deepEqual(plan?.conflicts, []);
  assert.deepEqual(plan?.suggested, { ...final, description: "Deep blue" });
});

test("independent saved edits to different fields both survive", () => {
  const separate = [
    { id: "title", createdAt: "2026-09-11T01:00:00Z", textFallback: { before: base, after: { ...base, title: "New title" }, epoch: "epoch-a", actorId: "actor-a" } },
    { id: "notes", createdAt: "2026-09-11T01:00:01Z", textFallback: { before: base, after: { ...base, technicalNotes: "New notes" }, epoch: "epoch-a", actorId: "actor-b" } },
  ];
  const plan = textRecoveryPlan(separate, base, "epoch-a");
  assert.deepEqual(plan?.conflicts, []);
  assert.deepEqual(plan?.suggested, { ...base, title: "New title", technicalNotes: "New notes" });
  assert.deepEqual(plan?.choices.title.map((choice) => choice.actorId), ["actor-a"]);
  assert.deepEqual(plan?.choices.technicalNotes.map((choice) => choice.actorId), ["actor-b"]);
});

test("independent edits to the same field keep both author-labelled choices", () => {
  const separate = [
    { id: "first", createdAt: "2026-09-11T01:00:00Z", textFallback: { before: base, after: { ...base, title: "Actor A's title" }, epoch: "epoch-a", actorId: "actor-a" } },
    { id: "second", createdAt: "2026-09-11T01:00:01Z", textFallback: { before: base, after: { ...base, title: "Actor B's title" }, epoch: "epoch-a", actorId: "actor-b" } },
  ];
  const plan = textRecoveryPlan(separate, base, "epoch-a");
  assert.deepEqual(plan?.conflicts, ["title"]);
  assert.equal(plan?.suggested.title, base.title);
  assert.deepEqual(plan?.choices.title.map(({ actorId, value }) => [actorId, value]), [["actor-a", "Actor A's title"], ["actor-b", "Actor B's title"]]);
});

test("concurrent edits to the same field require review", () => {
  const plan = textRecoveryPlan(items, { ...base, title: "Other editor" }, "epoch-a");
  assert.deepEqual(plan?.conflicts, ["title"]);
  assert.equal(plan?.suggested.title, "Other editor");
});

test("text already present on the server needs no conflict choice", () => {
  const plan = textRecoveryPlan(items, final, "epoch-a");
  assert.deepEqual(plan?.conflicts, []);
  assert.deepEqual(plan?.suggested, final);
});

test("old records and old epochs cannot be repaired automatically", () => {
  assert.equal(textRecoveryPlan([...items, { id: "old", createdAt: "2026-09-11T01:00:02Z" }], base, "epoch-a"), null);
  assert.equal(textRecoveryPlan(items, base, "epoch-b"), null);
});
