import { env } from "cloudflare:workers";
import { syncHeaders } from "../../../../lib/sync-v2/http";
import { SYNC_PROTOCOL } from "../../../../lib/sync-v2/protocol";
import { readSyncHead } from "../../../../lib/sync-v2/server-storage";

export async function GET(request: Request) {
  const head = await readSyncHead(env.DB);
  if (!head) return Response.json({ protocol: SYNC_PROTOCOL, code: "migration_required" }, { status: 503, headers: syncHeaders() });
  const url = new URL(request.url);
  const after = Number(url.searchParams.get("after") ?? 0);
  const requestedThrough = Number(url.searchParams.get("through") ?? head.sequence);
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(requestedThrough) || requestedThrough < after) return Response.json({ error: "Invalid event cursor" }, { status: 400, headers: syncHeaders(head.sequence) });
  const through = Math.min(requestedThrough, head.sequence);
  const result = await env.DB.prepare("SELECT sequence,operation_id,kind,target_id,summary,created_at FROM sync_events WHERE workspace_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT 200").bind(head.workspace_id, after, through).all<{ sequence: number; operation_id: string; kind: string; target_id: string | null; summary: string; created_at: string }>();
  const events = (result.results ?? []).map((row) => ({ protocol: SYNC_PROTOCOL, epoch: head.epoch, sequence: row.sequence, operationId: row.operation_id, kind: row.kind, targetId: row.target_id ?? undefined, summary: JSON.parse(row.summary), createdAt: row.created_at }));
  const nextCursor = events.at(-1)?.sequence ?? after;
  return Response.json({ protocol: SYNC_PROTOCOL, epoch: head.epoch, sequence: head.sequence, through, nextCursor, complete: nextCursor >= through, serverTime: new Date().toISOString(), events }, { headers: syncHeaders(head.sequence) });
}
