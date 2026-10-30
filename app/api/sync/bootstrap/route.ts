import { cueNumbersForTransport } from "../../../../lib/cue-numbering";
import { env } from "cloudflare:workers";
import { SYNC_PROTOCOL } from "../../../../lib/sync-v2/protocol";
import { loadSyncProjection, readSyncHead } from "../../../../lib/sync-v2/server-storage";
import { syncHeaders } from "../../../../lib/sync-v2/http";

export async function GET(request: Request) {
  const testMode = (env as unknown as { SYNC_V2_TEST_MODE?: string }).SYNC_V2_TEST_MODE;
  if (testMode === "1" && request.headers.get("cookie")?.split(";").some((part) => part.trim() === "sync-v2-test-bootstrap=offline")) {
    return Response.json({ protocol: SYNC_PROTOCOL, code: "test_transport_unavailable" }, { status: 503, headers: syncHeaders() });
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await readSyncHead(env.DB);
    if (!head) return Response.json({ protocol: SYNC_PROTOCOL, code: "migration_required", message: "Sync v2 has not been prepared for this workspace." }, { status: 503, headers: syncHeaders() });
    const etag = `"sync-${head.epoch}-${head.sequence}"`;
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...syncHeaders(head.sequence), etag } });
    const [projection, textDocuments, notices] = await Promise.all([
      loadSyncProjection(env.DB),
      env.DB.prepare("SELECT cue_id,revision,workspace_sequence,state_hash FROM sync_text_documents WHERE workspace_id=? AND workspace_sequence<=? ORDER BY cue_id").bind(head.workspace_id, head.sequence).all<{ cue_id: string; revision: number; workspace_sequence: number; state_hash: string }>(),
      env.DB.prepare("SELECT n.id,n.operation_id,n.profile_id,n.code,n.payload,n.created_at,o.target_id FROM sync_notices n LEFT JOIN sync_operations o ON o.workspace_id=n.workspace_id AND o.operation_id=n.operation_id WHERE n.workspace_id=? AND n.acknowledged_at IS NULL ORDER BY n.created_at,n.id").bind(head.workspace_id).all<{ id: string; operation_id: string | null; profile_id: string | null; code: string; payload: string; created_at: string; target_id: string | null }>(),
    ]);
    const after = await readSyncHead(env.DB);
    if (!after || after.epoch !== head.epoch || after.sequence !== head.sequence) continue;
    return Response.json({
      protocol: SYNC_PROTOCOL,
      protocolRange: { minimum: head.protocol_min, maximum: head.protocol_max },
      workspaceId: head.workspace_id,
      epoch: head.epoch,
      sequence: head.sequence,
      writeMode: head.write_mode,
      serverTime: new Date().toISOString(),
      state: cueNumbersForTransport(projection.state),
      versions: projection.versions,
      textDocuments: (textDocuments.results ?? []).map((row) => ({ cueId: row.cue_id, revision: row.revision, sequence: row.workspace_sequence, hash: row.state_hash })),
      notices: (notices.results ?? []).map((row) => {
        let payload: { status?: string; message?: string; outcome?: Record<string, unknown> } & Record<string, unknown> = {};
        try { payload = JSON.parse(row.payload) as typeof payload; } catch { /* Keep the notice visible even if an older payload is unreadable. */ }
        return { id: row.id, operationId: row.operation_id ?? undefined, profileId: row.profile_id ?? undefined, targetId: row.target_id ?? undefined, code: row.code, status: payload.status, message: payload.message, outcome: payload.outcome ?? payload, createdAt: row.created_at };
      }),
      document: projection.state.document,
    }, { headers: { ...syncHeaders(head.sequence), etag } });
  }
  return Response.json({ protocol: SYNC_PROTOCOL, code: "snapshot_busy", message: "The workspace changed while preparing this view. Retry shortly." }, { status: 503, headers: syncHeaders() });
}
