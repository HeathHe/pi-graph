import { reconciliationSummary, type KnowledgeReconciliation } from '../../knowledge/reconcile.js';
import { SessionStore } from '../store.js';
/** Unexpected generation failure. Missing report.md still returns null. */
export declare class V3KnowledgeReconciliationError extends Error {
    readonly cause?: unknown;
    constructor(message: string, cause?: unknown);
}
/**
 * Generate the v3 Run knowledge reconciliation receipt (pure computation, no
 * writes). Reuses the v2 reconciliation engine verbatim
 * (reconcileRunKnowledgeSync); the caller decides how to persist it. In the
 * v3 complete path the receipt is committed inside the same atomic
 * withV30Transaction as the staged knowledge delta (mutation-engine.ts), so
 * reconciliation and staging can never diverge.
 *
 * Returns null only when report.md is absent (nothing to reconcile). Invalid
 * frontmatter and engine failures throw V3KnowledgeReconciliationError so
 * callers can surface them instead of treating failure as success.
 */
export declare function generateV3RunKnowledgeReconciliation(projectRoot: string, sessionId: string, runId: string): KnowledgeReconciliation | null;
/**
 * Compatibility v3 reconciliation hook. Generation remains pure; persistence
 * uses the fenced v3 knowledge transaction (and the legacy lifecycle writer
 * for older schema generations).
 */
export declare function reconcileV3RunKnowledge(projectRoot: string, sessionId: string, runId: string): KnowledgeReconciliation | null;
/**
 * Read the v3 Run knowledge reconciliation receipt from the same path v2 uses
 * (reconciliationPath). JSON.parse + schema validation; any failure returns
 * null so callers treat a missing or corrupted receipt as "not reconciled".
 */
export declare function readV3KnowledgeReconciliation(store: SessionStore, sessionId: string, runId: string): KnowledgeReconciliation | null;
/**
 * v2-aligned summary shape (reconcile.ts reconciliationSummary): candidates/
 * counts digest including the review_required count. Delegating to the shared
 * v2 function guarantees the v3 check payload stays byte-identical in shape.
 */
export declare function v3ReconciliationSummary(receipt: KnowledgeReconciliation): ReturnType<typeof reconciliationSummary>;
//# sourceMappingURL=knowledge-v3.d.ts.map