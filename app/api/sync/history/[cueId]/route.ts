import { env } from "cloudflare:workers";
import { syncHeaders } from "../../../../../lib/sync-v2/http";
import { SYNC_PROTOCOL } from "../../../../../lib/sync-v2/protocol";
import { readSyncHead } from "../../../../../lib/sync-v2/server-storage";
import { safeSyncId } from "../../../../../lib/sync-v2/validation";

export async function GET(request: Request, context: { params: Promise<{ cueId: string }> }) {
  const { cueId } = await context.params;
  if (!safeSyncId(cueId)) return Response.json({ error: "Invalid cue ID" }, { status: 400, headers: syncHeaders() });
  const head = await readSyncHead(env.DB);
  if (!head) return Response.json({ protocol: SYNC_PROTOCOL, code: "migration_required" }, { status: 503, headers: syncHeaders() });
  const url = new URL(request.url);
  const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(before) || before < 1) return Response.json({ error: "Invalid history cursor" }, { status: 400, headers: syncHeaders(head.sequence) });
  const [result, documentResult] = await env.DB.batch([
    env.DB.prepare("SELECT revision,sequence,operation_id,title,description,technical_notes,actor_id,created_at FROM sync_text_history WHERE workspace_id=? AND cue_id=? AND revision<? ORDER BY revision DESC LIMIT 50").bind(head.workspace_id, cueId, before),
    env.DB.prepare("SELECT revision FROM sync_text_documents WHERE workspace_id=? AND cue_id=?").bind(head.workspace_id, cueId),
  ]);
  const currentDocumentRevision = Number((documentResult.results?.[0] as { revision?: number } | undefined)?.revision);
  if (!Number.isSafeInteger(currentDocumentRevision)) return Response.json({ protocol: SYNC_PROTOCOL, epoch: head.epoch, code: "history_missing", cueId }, { status: 404, headers: syncHeaders(head.sequence) });
  const versions = (result.results ?? []).map((row) => ({ revision: row.revision, sequence: row.sequence, operationId: row.operation_id, title: row.title, description: row.description, technicalNotes: row.technical_notes, actorId: row.actor_id, createdAt: row.created_at }));
  return Response.json({ protocol: SYNC_PROTOCOL, epoch: head.epoch, sequence: head.sequence, cueId, currentDocumentRevision, nextCursor: versions.length === 50 ? versions.at(-1)?.revision ?? null : null, versions }, { headers: syncHeaders(head.sequence) });
}
