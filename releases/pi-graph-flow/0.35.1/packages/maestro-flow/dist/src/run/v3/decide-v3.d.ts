import type { SessionStateV30 } from '../schemas.js';
import type { SessionStore } from '../store.js';
import type { V3MutationIdentity, V3MutationResult } from './mutation-engine.js';
export type DecideV3Verdict = 'proceed' | 'fix' | 'escalate';
export type DecideV3Confidence = 'high' | 'medium' | 'low';
export interface DecideV3Input extends V3MutationIdentity {
    pointId: string;
    verdict: DecideV3Verdict;
    confidence: DecideV3Confidence;
    summary?: string | null;
    expectedOrchestrationRevision: number;
    afterStepId?: string | null;
}
/**
 * Record a decision point verdict against a session/3.0 Session authority.
 *
 * Shared by `decideV3` (standalone mutation) and `completeRunAndAdvance`
 * (chain-proposal decide operations, applied atomically inside the same
 * transaction). It owns the decisions-array upsert, the chain step
 * decision_refs linkage, and the verdict → status / status transition
 * mapping. It deliberately does NOT stage transactions, CAS revisions, or
 * receipts — callers own those (plus the payload hash for replay identity).
 *
 * Verdict semantics:
 *   proceed/fix → decision ref becomes `resolved`, Session stays `open`
 *   escalate    → decision ref becomes `escalated`, Session stays in its
 *                 current status (no pause). Chain advancement past a gate
 *                 stays blocked until the decision is re-decided to
 *                 proceed/fix (enforced by the run next gate check in
 *                 mutation-engine.ts).
 */
export declare function applyV3DecisionRecord(session: SessionStateV30, input: {
    pointId: string;
    verdict: DecideV3Verdict;
    confidence: DecideV3Confidence;
    summary?: string | null;
    evidenceRefs?: string[];
    afterStepId?: string | null;
}): {
    session: SessionStateV30;
    decisionStatus: 'resolved' | 'escalated';
};
/**
 * Record a decision point verdict against a session/3.0 Session.
 *
 * Mirrors `completeRunAndAdvance` from mutation-engine.ts: normalized identity,
 * canonical payload hash, one locked withV30Transaction, request-receipt replay
 * idempotency, orchestration-revision CAS, then one staged transition receipt.
 * The decisions array upsert and the chain step decision_refs linkage commit
 * together with the receipt, so replays never re-apply.
 *
 * Verdict semantics:
 *   proceed/fix → decision ref becomes `resolved`, Session stays `open`
 *   escalate    → decision ref becomes `escalated`, Session stays in its
 *                 current status (no pause). Chain advancement past a gate
 *                 stays blocked until the decision is re-decided.
 */
export declare function decideV3(store: SessionStore, input: DecideV3Input): V3MutationResult;
//# sourceMappingURL=decide-v3.d.ts.map