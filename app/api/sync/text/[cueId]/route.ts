import { env } from "cloudflare:workers";
import { bytesToBase64 } from "../../../../../lib/sync-v2/encoding";
import { syncHeaders } from "../../../../../lib/sync-v2/http";
import { SYNC_PROTOCOL } from "../../../../../lib/sync-v2/protocol";
import { readCanonicalTextDocument, readTextDocumentVersion } from "../../../../../lib/sync-v2/server-storage";
import { safeSyncId } from "../../../../../lib/sync-v2/validation";

function textEtag(epoch: string, cueId: string, revision: number, hash: string) {
  return `"text-${epoch}-${cueId}-${revision}-${hash}"`;
}

export async function GET(request: Request, context: { params: Promise<{ cueId: string }> }) {
  const { cueId } = await context.params;
  if (!safeSyncId(cueId)) return Response.json({ error: "Invalid cue ID" }, { status: 400, headers: syncHeaders() });
  const version = await readTextDocumentVersion(env.DB, cueId);
  if (!version) return Response.json({ protocol: SYNC_PROTOCOL, code: "migration_required" }, { status: 503, headers: syncHeaders() });
  if (version.revision === null || version.state_hash === null) return Response.json({ error: "Cue text document not found" }, { status: 404, headers: syncHeaders(version.sequence) });
  const currentEtag = textEtag(version.epoch, cueId, version.revision, version.state_hash);
  if (request.headers.get("if-none-match") === currentEtag) {
    return new Response(null, { status: 304, headers: { ...syncHeaders(version.sequence), etag: currentEtag } });
  }
  const row = await readCanonicalTextDocument(env.DB, cueId);
  if (!row) return Response.json({ error: "Cue text document not found" }, { status: 404, headers: syncHeaders(version.sequence) });
  return Response.json({ protocol: SYNC_PROTOCOL, workspaceId: version.workspace_id, epoch: version.epoch, sequence: version.sequence, cueId, revision: row.revision, documentSequence: row.workspace_sequence, encodedState: bytesToBase64(row.encodedState), stateVector: bytesToBase64(new Uint8Array(row.state_vector)), hash: row.state_hash, updatedAt: row.updated_at }, { headers: { ...syncHeaders(version.sequence), etag: textEtag(version.epoch, cueId, row.revision, row.state_hash) } });
}
