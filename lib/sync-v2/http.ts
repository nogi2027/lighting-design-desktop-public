export async function readLimitedJson(request: Request, maximumBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { ok: false, response: Response.json({ error: "Content-Type must be application/json" }, { status: 415 }) };
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) return { ok: false, response: Response.json({ error: "Sync request is too large" }, { status: 413 }) };
  if (!request.body) return { ok: false, response: Response.json({ error: "A JSON body is required" }, { status: 400 }) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooLarge = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) tooLarge = true;
    else if (!tooLarge) chunks.push(value);
  }
  if (tooLarge) return { ok: false, response: Response.json({ error: "Sync request is too large" }, { status: 413 }) };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) }; }
  catch { return { ok: false, response: Response.json({ error: "Invalid JSON body" }, { status: 400 }) }; }
}

export function syncHeaders(sequence?: number) {
  return {
    "cache-control": "no-store",
    ...(sequence === undefined ? {} : { "x-sync-sequence": String(sequence) }),
    "x-content-type-options": "nosniff",
  };
}
