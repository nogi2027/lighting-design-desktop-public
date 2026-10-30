import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { retainedResource } from "../lib/retained-resource.ts";
import { shareWorkspaceState } from "../lib/workspace-sharing.ts";
import { defaultState } from "../lib/default-state.ts";
import { createSceneLocator, sceneAtPosition } from "../lib/scene-boundaries.ts";

test("view switches share an in-flight resource and release it only after the last user leaves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let loads = 0;
  const disposed = [];
  const acquire = retainedResource(async () => ({ id: ++loads }), (value) => disposed.push(value.id), 100);
  const first = acquire();
  const second = acquire();
  assert.equal(first.promise, second.promise);
  await first.promise;
  first.release();
  first.release(); // cleanup is idempotent
  t.mock.timers.tick(101);
  assert.deepEqual(disposed, []);
  second.release();
  t.mock.timers.tick(50);
  const returning = acquire();
  assert.equal(returning.promise, first.promise);
  t.mock.timers.tick(101);
  assert.deepEqual(disposed, []);
  returning.release();
  t.mock.timers.tick(101);
  await Promise.resolve();
  assert.deepEqual(disposed, [1]);
  const next = acquire();
  assert.equal((await next.promise).id, 2);
  next.release();
});

test("failed resource loads are retried without an old cleanup destroying the replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let loads = 0;
  const disposed = [];
  const acquire = retainedResource(async () => {
    if (++loads === 1) throw new Error("offline");
    return loads;
  }, (value) => disposed.push(value), 100);
  const failed = acquire();
  await assert.rejects(failed.promise, /offline/);
  const replacement = acquire();
  assert.equal(await replacement.promise, 2);
  failed.release();
  t.mock.timers.tick(101);
  await Promise.resolve();
  assert.deepEqual(disposed, []);
  assert.equal(acquire().promise, replacement.promise);
  replacement.release();
});

test("unchanged snapshots preserve identities; edits, deletes and ordering remain authoritative", () => {
  const before = { ...structuredClone(defaultState), cues: [{ id: "one", title: "First" }, { id: "two", title: "Second" }] };
  assert.equal(shareWorkspaceState(before, structuredClone(before)), before);
  const edited = structuredClone(before);
  edited.cues[0].title = "Changed remotely";
  const next = shareWorkspaceState(before, edited);
  assert.notEqual(next.cues, before.cues);
  assert.equal(next.cues[0].title, "Changed remotely");
  assert.equal(next.cues[1], before.cues[1]);
  assert.equal(next.scenes, before.scenes);
  assert.equal(next.discussions, before.discussions);
  const reordered = { ...next, cues: [...next.cues].reverse() };
  assert.deepEqual(shareWorkspaceState(next, reordered).cues, reordered.cues);
  const removed = { ...next, cues: next.cues.slice(1) };
  assert.deepEqual(shareWorkspaceState(next, removed).cues, removed.cues);
  const withConflicts = { ...next, conflicts: [] };
  assert.equal(Object.hasOwn(shareWorkspaceState(withConflicts, next), "conflicts"), false);
});

test("indexed scene lookup preserves exact boundaries, same-page groups and unsorted input", () => {
  const scenes = [...defaultState.scenes].reverse();
  const locate = createSceneLocator(scenes);
  for (let page = 1; page <= 108; page++) {
    for (const y of [0, .1, .2312, .5, .9, 1]) assert.equal(locate(page, y), sceneAtPosition(scenes, page, y));
  }
  for (const scene of scenes) {
    assert.equal(locate(scene.pageStart, scene.startY), sceneAtPosition(scenes, scene.pageStart, scene.startY));
    assert.equal(locate(scene.pageStart, scene.startY - .000001), sceneAtPosition(scenes, scene.pageStart, scene.startY - .000001));
  }
  assert.equal(createSceneLocator([])(9), undefined);
});

function workerContext() {
  const handlers = {};
  const context = vm.createContext({
    self: { addEventListener: (name, callback) => { handlers[name] = callback; } },
    Response, crypto, Uint8Array, TextEncoder, URL,
  });
  vm.runInContext(readFileSync(new URL("../public/sync-v2-sw.js", import.meta.url), "utf8"), context);
  return context;
}

test("offline asset work runs concurrently with a bounded number of buffers and stable ordering", async () => {
  const context = workerContext();
  let active = 0;
  let peak = 0;
  const releases = [];
  context.work = async (value) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => releases.push(resolve));
    active--;
    return value * 2;
  };
  const pending = vm.runInContext("mapConcurrent([1,2,3,4,5,6,7], work, 3)", context);
  assert.equal(peak, 3);
  while (releases.length) {
    releases.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(Array.from(await pending), [2,4,6,8,10,12,14]);
  assert.equal(peak, 3);
});

test("concurrent offline verification still rejects missing or corrupted assets", async () => {
  const context = workerContext();
  const contents = new Map();
  context.cache = {
    match: async (key) => contents.get(key)?.clone(),
    put: async (key, value) => { contents.set(key, value); },
  };
  const identity = await vm.runInContext('cacheResponse(cache, "/test.js", new Response("original"))', context);
  contents.set("/__sync-v2-cache-manifest", new Response(JSON.stringify({ version: vm.runInContext("VERSION", context), entries: [identity] })));
  assert.equal(await vm.runInContext("verifyCache(cache)", context), true);
  contents.set("/test.js", new Response("tampered"));
  assert.equal(await vm.runInContext("verifyCache(cache)", context), false);
  contents.delete("/test.js");
  assert.equal(await vm.runInContext("verifyCache(cache)", context), false);
});
