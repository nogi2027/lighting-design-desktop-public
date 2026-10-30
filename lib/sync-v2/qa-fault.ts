// Only the QA fault lab passes this option to processOperation. The duplicate
// primary-key write is a real D1 error inside the same transactional batch.
export type QaFaultPoint = "after_head" | "after_effects" | "after_text_document" | "after_receipt" | "after_event";
export type QaFault = { point: QaFaultPoint; fired: boolean; statementCount: number };

export function withQaFault(db: D1Database, statements: D1PreparedStatement[], trailerStart: number, fault?: QaFault, textDocumentIndex?: number) {
  if (!fault) return statements;
  const index = fault.point === "after_head" ? 0
    : fault.point === "after_effects" ? trailerStart - 1
    : fault.point === "after_text_document" ? textDocumentIndex
    : fault.point === "after_receipt" ? trailerStart + 1
    : trailerStart + 2;
  if (index === undefined || index < 0 || index >= statements.length) throw new Error("Unsupported QA fault point for this operation.");
  fault.fired = true;
  fault.statementCount = statements.length;
  const duplicateHead = db.prepare("INSERT INTO sync_head SELECT * FROM sync_head WHERE workspace_id=?").bind("lighting-design");
  return [...statements.slice(0, index + 1), duplicateHead, ...statements.slice(index + 1)];
}
