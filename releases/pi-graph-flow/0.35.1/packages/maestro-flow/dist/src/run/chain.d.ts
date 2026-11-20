import type { CommandRun, OrchestrationStep, PendingRetryToken, SessionState } from './schemas.js';
/** Index of the single `running` chain step, or null when none is active. */
export declare function activeStepIndex(session: SessionState): number | null;
/**
 * Index of the next `pending` execution step. Decision nodes (`decision_ref`
 * set) are skipped by default — they are evaluated by the orchestrator, not
 * dispatched as Runs.
 */
export declare function nextPendingIndex(session: SessionState, skipDecisions?: boolean): number | null;
/** Index of the next `pending` decision node, or null. */
export declare function nextPendingDecisionIndex(session: SessionState): number | null;
/**
 * Set a chain step's status (and optionally its run_id) through the canonical
 * store transaction. Originally mirrored updateChainStepStatus from the retired
 * src/ralph/session-adapter.ts (removed), minus the ralph-meta side channel.
 */
export declare function updateChainStepStatus(projectRoot: string, sessionId: string, stepIndex: number, status: OrchestrationStep['status'], runId?: string | null): void;
/** The step's retry counter after a bump — count/max, both always present. */
export interface RetryState {
    count: number;
    max: number;
    /** True when count has reached (or passed) max — the ceiling is exhausted. */
    exhausted: boolean;
}
export declare function issueRetryToken(sessionId: string, step: OrchestrationStep, run: CommandRun, now?: Date): PendingRetryToken;
/**
 * Requeue a chain step for retry in one store transaction: status back to
 * `pending`, run_id cleared, and `retry.count` incremented (seeding the block
 * with the default ceiling when the step had none). Equivalent to the ralph
 * policy's NEEDS_RETRY path (defined in maestro-ralph.md;
 * `retry_count = (retry_count ?? 0) + 1`); the CLI does not cap
 * the count — the retry ceiling is a prompt-layer FSM decision — but the returned
 * `exhausted` flag lets the caller report when count has met max.
 */
export declare function requeueChainStepForRetry(projectRoot: string, sessionId: string, stepIndex: number): RetryState;
//# sourceMappingURL=chain.d.ts.map