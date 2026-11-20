import { type SessionBundle } from './store.js';
import type { SessionState } from './schemas.js';
import { type ExecutionLeaseClaim } from './lease.js';
import { type TransitionMutationOptions, type TransitionMutationReceipt } from './transition-receipts.js';
export type DecisionVerdict = 'proceed' | 'fix' | 'escalate';
export type DecisionConfidence = 'high' | 'medium' | 'low';
export interface DecideNextSuggestion {
    suggest_only: true;
    action: 'resolve_session' | 'insert_fix' | 'dispatch_next';
    command: string | null;
    reason: string;
    preconditions: string[];
}
export interface DecideOptions {
    verdict: DecisionVerdict;
    confidence: DecisionConfidence;
    summary?: string;
    /** Evidence path/reference recorded on decision_point.evidence_ref. */
    evidence?: string;
    transition?: Partial<TransitionMutationOptions>;
}
export interface DecideResult {
    session_id: string;
    point_id: string;
    verdict: DecisionVerdict;
    confidence: DecisionConfidence;
    /** decision_point.status after the verdict. */
    point_status: string;
    /** Retry counter after a fix bump (null for proceed / escalate). */
    retry: {
        count: number;
        max: number;
        exhausted: boolean;
    } | null;
    /** The matching chain decision node, or null when none references this point. */
    chain: {
        step_id: string;
        index: number;
        step_status: string;
    } | null;
    /** Session status after the verdict (paused on escalate, unchanged otherwise). */
    session_status: SessionState['status'];
    /** Next-step pointer closing decide → next. */
    next: DecideNextSuggestion;
    transition: TransitionMutationReceipt;
    /** Projection failures never roll back decision authority. */
    projection_pending: boolean;
}
interface DecisionProjectionRecord {
    transition_id: string;
    type: 'decide';
    point_id: string;
    verdict: DecisionVerdict;
    confidence: DecisionConfidence;
    summary: string | null;
    evidence_ref: string | null;
    retry_count: number | null;
    timestamp: string;
}
/** Rebuild the deterministic, de-duplicated decisions.ndjson receipt projection. */
export declare function ensureDecisionLogProjection(projectRoot: string, sessionId: string, requiredTransitionId?: string): boolean;
type DecideAuthorityResult = Omit<DecideResult, 'transition' | 'projection_pending'>;
/** Apply one decision to an in-memory authority draft and build its projection. */
export declare function applyDecideMutation(draft: SessionBundle, pointId: string, options: DecideOptions, transitionId: string, appliedAt: string): {
    decision: DecideAuthorityResult;
    decision_projection: DecisionProjectionRecord;
};
export interface DecideExecutionOptions extends Omit<DecideOptions, 'transition'> {
    requestId: string;
    expectedExecutionRevision: number;
    executionLease: ExecutionLeaseClaim;
}
/** Execution-aware decision authority with transition/1.1 durability. */
export declare function runDecideExecution(projectRoot: string, sessionId: string, executionId: string, pointId: string, options: DecideExecutionOptions): DecideResult;
/**
 * Record a decision verdict onto a session's decision point and advance the
 * chain. Throws when the session or the point is missing (the caller surfaces
 * the message on stderr with exit 1).
 */
export declare function runDecide(projectRoot: string, sessionId: string, pointId: string, options: DecideOptions): DecideResult;
export {};
