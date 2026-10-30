import { env } from "cloudflare:workers";
import { readLimitedJson, syncHeaders } from "../../../../lib/sync-v2/http";
import { MAX_SYNC_REQUEST_BYTES, SYNC_PROTOCOL } from "../../../../lib/sync-v2/protocol";
import { type QaFault, type QaFaultPoint } from "../../../../lib/sync-v2/qa-fault";
import { processOperation } from "../../../../lib/sync-v2/server-storage";
import { validOperationBatch } from "../../../../lib/sync-v2/validation";

export async function POST(request: Request) {
  const parsed = await readLimitedJson(request, MAX_SYNC_REQUEST_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = Array.isArray(parsed.value) ? parsed.value : (parsed.value as { operations?: unknown })?.operations;
  if (!validOperationBatch(body)) return Response.json({ error: "A valid operation batch is required" }, { status: 400, headers: syncHeaders() });
  const results = [];
  for (const envelope of body) {
    try {
      let qaFault: QaFault | undefined;
      const faultKind = envelope.action.type === "setBlackout" ? "structured" : envelope.action.type === "applyTextUpdate" ? "text" : null;
      const faultCueId = envelope.action.type === "setBlackout" || envelope.action.type === "applyTextUpdate" ? envelope.action.cueId : null;
      if ((env as unknown as { QA_TESTING?: string }).QA_TESTING === "1" && faultCueId && /^qa-fault-[a-z0-9-]{8,80}$/.test(faultCueId)) {
        const table = await env.DB.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='qa_fault_arms_v2'").first();
        if (table) {
          const arm = await env.DB.prepare("SELECT point FROM qa_fault_arms_v2 WHERE cue_id=? AND kind=? AND expires_at>?").bind(faultCueId, faultKind, Date.now()).first<{ point: QaFaultPoint }>();
          if (arm) {
            const consumed = await env.DB.prepare("DELETE FROM qa_fault_arms_v2 WHERE cue_id=? AND kind=? AND expires_at>?").bind(faultCueId, faultKind, Date.now()).run();
            if (Number(consumed.meta.changes ?? 0) === 1) qaFault = { point: arm.point, fired: false, statementCount: 0 };
          }
        }
      }
      const result = await processOperation(env.DB, envelope, qaFault);
      if (qaFault?.fired && result.status === "retry_later") {
        const receipt = await env.DB.prepare("SELECT 1 AS found FROM sync_receipts WHERE workspace_id=? AND operation_id=?").bind(envelope.workspaceId, envelope.operationId).first();
        results.push(receipt ? result : { ...result, status: "invalid" as const, code: "qa_d1_fault", message: "A real QA D1 batch failed. This cue's unsaved change is kept in Recovery.", outcome: { targetId: faultCueId, kind: faultKind, point: qaFault.point }, retryAfterMs: undefined });
      } else results.push(result);
    } catch (error) {
      console.error("sync_v2_operation_failed", {
        operationId: envelope.operationId,
        kind: envelope.action.type,
        targetId: "cueId" in envelope.action ? envelope.action.cueId : undefined,
        message: error instanceof Error ? error.message : "Unknown server error",
      });
      results.push({
        protocol: SYNC_PROTOCOL,
        workspaceId: envelope.workspaceId,
        epoch: envelope.epoch,
        operationId: envelope.operationId,
        status: "retry_later" as const,
        code: "server_error",
        message: "The server could not confirm this saved change yet.",
        retryAfterMs: 500,
      });
    }
  }
  const idReuse = results.some((result) => result.code === "operation_id_reused");
  const protocolMismatch = results.some((result) => result.code === "protocol_mismatch");
  const sequence = results.reduce((latest, result) => Math.max(latest, result.sequence ?? 0), 0);
  return Response.json({ protocol: SYNC_PROTOCOL, epoch: results.at(-1)?.epoch ?? body[0].epoch, sequence, results }, { status: idReuse ? 409 : protocolMismatch ? 426 : 200, headers: syncHeaders(sequence) });
}
