import * as Y from "yjs";
import { base64ToBytes, bytesToBase64, sha256 } from "./encoding.ts";

export const YJS_TEXT_FIELDS = ["title", "description", "technicalNotes"] as const;
export type YjsTextField = typeof YJS_TEXT_FIELDS[number];

type DecodedId = { client: number; clock: number };
type DecodedStruct = {
  id: DecodedId;
  length: number;
  origin: DecodedId | null;
  rightOrigin: DecodedId | null;
  parent: string | DecodedId | null;
};
type DecodedDeleteRange = { clock: number; len: number };

export type CanonicalTextDocument = {
  encodedState: Uint8Array;
  stateVector: Uint8Array;
  title: string;
  description: string;
  technicalNotes: string;
  hash: string;
};

export type TextUpdateInput = {
  encodedState: Uint8Array;
  revision: number;
  baseDocumentRevision: number;
  baseStateVector: Uint8Array;
  resultStateVector: Uint8Array;
  update: Uint8Array;
};

export type TextUpdateValidation =
  | { ok: true; document: CanonicalTextDocument }
  | { ok: false; code: "stale_document" | "dependency_pending" | "invalid_update"; message: string; details?: Record<string, unknown> };

function vector(bytes: Uint8Array) {
  return Y.decodeStateVector(bytes);
}

export function vectorDominates(left: Map<number, number>, right: Map<number, number>) {
  for (const [client, clock] of right) if ((left.get(client) ?? 0) < clock) return false;
  return true;
}

function idAvailable(id: DecodedId | null, clocks: Map<number, number>) {
  return !id || id.clock < (clocks.get(id.client) ?? 0);
}

function validateDecodedUpdate(update: Uint8Array, known: Map<number, number>) {
  let decoded: { structs: DecodedStruct[]; ds: { clients: Map<number, DecodedDeleteRange[]> } };
  try {
    decoded = Y.decodeUpdate(update) as unknown as typeof decoded;
  } catch {
    return { ok: false as const, message: "The text update could not be decoded." };
  }

  const resulting = new Map(known);
  const byClient = new Map<number, DecodedStruct[]>();
  for (const struct of decoded.structs) {
    if (!Number.isSafeInteger(struct.id?.client) || !Number.isSafeInteger(struct.id?.clock) || !Number.isSafeInteger(struct.length) || struct.length <= 0) {
      return { ok: false as const, message: "The text update contains an invalid structure range." };
    }
    const list = byClient.get(struct.id.client) ?? [];
    list.push(struct);
    byClient.set(struct.id.client, list);
  }
  for (const [client, structs] of byClient) {
    structs.sort((left, right) => left.id.clock - right.id.clock);
    let clock = known.get(client) ?? 0;
    for (const struct of structs) {
      const end = struct.id.clock + struct.length;
      if (struct.id.clock > clock) return { ok: false as const, message: "The text update has a missing structure range." };
      clock = Math.max(clock, end);
    }
    resulting.set(client, clock);
  }

  for (const struct of decoded.structs) {
    if (!idAvailable(struct.origin, resulting) || !idAvailable(struct.rightOrigin, resulting)) {
      return { ok: false as const, message: "The text update refers to a missing neighbour." };
    }
    if (typeof struct.parent === "string" && !YJS_TEXT_FIELDS.includes(struct.parent as YjsTextField)) {
      return { ok: false as const, message: "The text update contains an unsupported shared field." };
    }
    if (struct.parent && typeof struct.parent !== "string" && !idAvailable(struct.parent, resulting)) {
      return { ok: false as const, message: "The text update refers to a missing parent." };
    }
  }
  for (const [client, ranges] of decoded.ds.clients) {
    const maximum = resulting.get(client) ?? 0;
    for (const range of ranges) {
      if (!Number.isSafeInteger(range.clock) || !Number.isSafeInteger(range.len) || range.clock < 0 || range.len <= 0 || range.clock + range.len > maximum) {
        return { ok: false as const, message: "The text update deletes an unknown structure range." };
      }
    }
  }
  return { ok: true as const };
}

function readDocument(doc: Y.Doc) {
  const values = Object.fromEntries(YJS_TEXT_FIELDS.map((field) => [field, doc.getText(field)])) as Record<YjsTextField, Y.Text>;
  const shared = [...doc.share.entries()];
  if (shared.some(([name, type]) => !YJS_TEXT_FIELDS.includes(name as YjsTextField) || !(type instanceof Y.Text))) {
    throw new Error("The text document contains an unsupported shared type.");
  }
  return {
    title: values.title.toString(),
    description: values.description.toString(),
    technicalNotes: values.technicalNotes.toString(),
  };
}

export function decodeCanonicalTextDocument(encodedState: Uint8Array) {
  const doc = new Y.Doc({ gc: true });
  for (const field of YJS_TEXT_FIELDS) doc.getText(field);
  Y.applyUpdate(doc, encodedState, "rollback-read");
  return readDocument(doc);
}

async function canonicalDocument(doc: Y.Doc): Promise<CanonicalTextDocument> {
  const encodedState = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);
  return { encodedState, stateVector, ...readDocument(doc), hash: await sha256(encodedState) };
}

export async function createCanonicalTextDocument(text: Pick<CanonicalTextDocument, "title" | "description" | "technicalNotes">) {
  const doc = new Y.Doc({ gc: true });
  for (const field of YJS_TEXT_FIELDS) if (text[field]) doc.getText(field).insert(0, text[field]);
  return canonicalDocument(doc);
}

export async function validateAndApplyTextUpdate(input: TextUpdateInput): Promise<TextUpdateValidation> {
  if (input.baseDocumentRevision > input.revision) {
    return { ok: false, code: "stale_document", message: "The cue changed before this text update was checked." };
  }
  let serverVector: Map<number, number>;
  let declaredBase: Map<number, number>;
  let declaredResult: Map<number, number>;
  try {
    serverVector = vector(Y.encodeStateVectorFromUpdate(input.encodedState));
    declaredBase = vector(input.baseStateVector);
    declaredResult = vector(input.resultStateVector);
  } catch {
    return { ok: false, code: "invalid_update", message: "The text update has an invalid state vector." };
  }
  if (!vectorDominates(serverVector, declaredBase)) {
    const missing = [...declaredBase].filter(([client, clock]) => (serverVector.get(client) ?? 0) < clock);
    return { ok: false, code: "dependency_pending", message: "Earlier text changes must arrive first.", details: { missing } };
  }
  const metadata = validateDecodedUpdate(input.update, serverVector);
  if (!metadata.ok) return { ok: false, code: "invalid_update", message: metadata.message };

  try {
    const doc = new Y.Doc({ gc: true });
    for (const field of YJS_TEXT_FIELDS) doc.getText(field);
    Y.applyUpdate(doc, input.encodedState, "server-base");
    Y.applyUpdate(doc, input.update, "server-operation");
    const document = await canonicalDocument(doc);
    if (!vectorDominates(vector(document.stateVector), declaredResult)) {
      return { ok: false, code: "invalid_update", message: "The applied document does not contain the declared result." };
    }
    return { ok: true, document };
  } catch (error) {
    return { ok: false, code: "invalid_update", message: error instanceof Error ? error.message : "The text update is invalid." };
  }
}

export function decodeTextAction(action: { baseStateVector: string; resultStateVector: string; update: string }) {
  return {
    baseStateVector: base64ToBytes(action.baseStateVector),
    resultStateVector: base64ToBytes(action.resultStateVector),
    update: base64ToBytes(action.update),
  };
}

export function encodeCanonicalDocument(document: CanonicalTextDocument) {
  return {
    encodedState: bytesToBase64(document.encodedState),
    stateVector: bytesToBase64(document.stateVector),
    hash: document.hash,
  };
}

export function createTextReplacementUpdate(encodedState: Uint8Array, replacement: Pick<CanonicalTextDocument, "title" | "description" | "technicalNotes">) {
  const doc = new Y.Doc({ gc: true });
  for (const field of YJS_TEXT_FIELDS) doc.getText(field);
  Y.applyUpdate(doc, encodedState, "server-base");
  const baseStateVector = Y.encodeStateVector(doc);
  doc.transact(() => {
    for (const field of YJS_TEXT_FIELDS) {
      const text = doc.getText(field);
      if (text.length) text.delete(0, text.length);
      if (replacement[field]) text.insert(0, replacement[field]);
    }
  }, "restore");
  return { baseStateVector, resultStateVector: Y.encodeStateVector(doc), update: Y.encodeStateAsUpdate(doc, baseStateVector) };
}
