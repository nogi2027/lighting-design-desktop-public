import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { createCanonicalTextDocument, validateAndApplyTextUpdate } from "../lib/sync-v2/yjs-document.ts";

function editFrom(document, edit) {
  const client = new Y.Doc({ gc: true });
  Y.applyUpdate(client, document.encodedState);
  const baseStateVector = Y.encodeStateVector(client);
  edit(client);
  return {
    baseStateVector,
    resultStateVector: Y.encodeStateVector(client),
    update: Y.encodeStateAsUpdate(client, baseStateVector),
  };
}

test("valid Yjs inserts and delete-only segments apply with declared state vectors", async () => {
  const original = await createCanonicalTextDocument({ title: "Cue", description: "Blue wash", technicalNotes: "Fade 3" });
  const insertion = editFrom(original, (doc) => doc.getText("description").insert(4, " deep"));
  const first = await validateAndApplyTextUpdate({ encodedState: original.encodedState, revision: 0, baseDocumentRevision: 0, ...insertion });
  assert.equal(first.ok, true);
  assert.equal(first.document.description, "Blue deep wash");

  const deletion = editFrom(first.document, (doc) => doc.getText("description").delete(4, 5));
  const second = await validateAndApplyTextUpdate({ encodedState: first.document.encodedState, revision: 1, baseDocumentRevision: 1, ...deletion });
  assert.equal(second.ok, true);
  assert.equal(second.document.description, "Blue wash");
});

test("a self-contained update includes optimistic structs that a delete-only capture omits", async () => {
  const original = await createCanonicalTextDocument({ title: "May", description: "", technicalNotes: "" });
  const client = new Y.Doc({ gc: true });
  Y.applyUpdate(client, original.encodedState);
  const acknowledgedVector = Y.encodeStateVector(client);

  client.getText("title").insert(3, "be");
  let deletion = new Uint8Array();
  const captureDeletion = (update) => { deletion = update; };
  client.on("update", captureDeletion);
  client.getText("title").delete(3, 2);
  client.off("update", captureDeletion);
  const resultStateVector = Y.encodeStateVector(client);

  assert.deepEqual([...Y.encodeStateVectorFromUpdate(deletion)], [0]);
  const broken = await validateAndApplyTextUpdate({
    encodedState: original.encodedState,
    revision: 5,
    baseDocumentRevision: 5,
    baseStateVector: acknowledgedVector,
    resultStateVector,
    update: deletion,
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.code, "invalid_update");

  const selfContained = Y.encodeStateAsUpdate(client, acknowledgedVector);
  const repaired = await validateAndApplyTextUpdate({
    encodedState: original.encodedState,
    revision: 5,
    baseDocumentRevision: 5,
    baseStateVector: acknowledgedVector,
    resultStateVector,
    update: selfContained,
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.document.title, "May");
});

test("duplicate updates are harmless and unsupported shared fields are rejected", async () => {
  const original = await createCanonicalTextDocument({ title: "Cue", description: "", technicalNotes: "" });
  const insertion = editFrom(original, (doc) => doc.getText("title").insert(3, " one"));
  const first = await validateAndApplyTextUpdate({ encodedState: original.encodedState, revision: 0, baseDocumentRevision: 0, ...insertion });
  assert.equal(first.ok, true);
  const duplicate = await validateAndApplyTextUpdate({ encodedState: first.document.encodedState, revision: 1, baseDocumentRevision: 1, ...insertion });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.document.title, "Cue one");

  const attacker = new Y.Doc();
  const baseStateVector = Y.encodeStateVector(attacker);
  attacker.getText("unexpected").insert(0, "payload");
  const invalid = await validateAndApplyTextUpdate({
    encodedState: new Uint8Array([0, 0]), revision: 0, baseDocumentRevision: 0, baseStateVector,
    resultStateVector: Y.encodeStateVector(attacker), update: Y.encodeStateAsUpdate(attacker, baseStateVector),
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "invalid_update");
});

test("stale revisions and absent causal structures remain unacknowledged", async () => {
  const original = await createCanonicalTextDocument({ title: "Cue", description: "", technicalNotes: "" });
  const foreign = new Y.Doc();
  foreign.getText("title").insert(0, "Foreign");
  const pending = await validateAndApplyTextUpdate({
    encodedState: original.encodedState, revision: 0, baseDocumentRevision: 0,
    baseStateVector: Y.encodeStateVector(foreign), resultStateVector: Y.encodeStateVector(foreign), update: new Uint8Array([0, 0]),
  });
  assert.equal(pending.ok, false);
  assert.equal(pending.code, "dependency_pending");
  const stale = await validateAndApplyTextUpdate({
    encodedState: original.encodedState, revision: 2, baseDocumentRevision: 3,
    baseStateVector: new Uint8Array([0]), resultStateVector: new Uint8Array([0]), update: new Uint8Array([0, 0]),
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale_document");
});
