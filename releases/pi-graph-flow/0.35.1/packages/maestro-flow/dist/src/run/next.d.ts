import { type CreateRunResult, type NamedGateBlocker, type PrevHandoff, type RunUpstream } from './runtime.js';
import { type ExecutionLeaseClaim } from './lease.js';
import type { TargetPlatform } from '../core/skill-converter.js';
/** Chain-forward preview entry: an upcoming step the orchestrator should expect. */
export interface QueueEntry {
    index: number;
    step_id: string;
    command: string;
    /** True when this queue entry is a decision node (evaluated, not dispatched). */
    is_decision: boolean;
}
/** A prior-step handoff.next[] suggestion surfaced to the orchestrator. */
export interface RecommendedEntry {
    command: string;
    reason: string;
    needs: string[];
}
export interface NextResult {
    session_id: string;
    run_id: string;
    run_dir: string;
    resolved_platform: TargetPlatform;
    /** Verbatim argv persisted on the already-created Run. */
    args: string[];
    argument_requirements: CreateRunResult['argument_requirements'];
    reuse_assessments: CreateRunResult['reuse_assessments'];
    /** Explicit invariant preventing executors from allocating a duplicate Run. */
    run_already_created: true;
    goal: string;
    step: {
        index: number;
        total: number;
        step_id: string;
        command: string;
    };
    upstream: Record<string, RunUpstream>;
    entry_gates: {
        passed: number;
        failed: number;
        skipped: number;
        blocking: number;
    };
    /** Bounded named entry blockers; full gate detail remains in `run brief`. */
    blockers: NamedGateBlocker[];
    prev_handoff: PrevHandoff | null;
    /** Prepare-declared deferred-reading refs (path + when). Manifest only. */
    refs: Array<{
        path: string;
        when: string;
    }>;
    brief: {
        command: string;
    };
    next: {
        command: string;
        reason: string;
    };
    /** Pending steps after the advanced one (chain-forward preview, max 3). */
    queue?: QueueEntry[];
    /** Prior step handoff.next[] suggestions (command + reason + needs). */
    recommended?: RecommendedEntry[];
    /** Full brief data when --inline-brief is requested (avoids a separate run brief call). */
    inline_brief?: unknown;
}
export interface NextCmdOptions {
    sessionId?: string;
    json?: boolean;
    /**
     * Command args forwarded to `createRun` (stored in run.command.args). The
     * retired ralph adapter used this to carry per-step args from ralph-meta;
     * `run next` leaves
     * this unset so its own behaviour is unchanged.
     */
    args?: string[];
    /**
     * Advance a specific pending execution step (by step_id) rather than the queue
     * head. The target must exist, be `pending`, and be an execution step (not a
     * decision node); otherwise exit 1. The single-running guard still applies.
     */
    pick?: string;
    /**
     * Lease claim checked against session.orchestration.lease before advancing.
     * A null lease (or a lease with a null owner) skips verification entirely, so
     * non-leased sessions are unaffected. A mismatch is exit 1 (mirrors the
     * retired ralph lease behaviour).
     */
    executionOwner?: string;
    ownerEpoch?: number;
    leaseId?: string;
    /**
     * Include full brief-level data (guidance, execution contract, continuity)
     * in the result. The executor can use this directly instead of calling
     * `maestro run brief` separately — the normal forward flow path.
     */
    inlineBrief?: boolean;
    /** Internal execution binding; omitted legacy calls retain the current unleased path. */
    execution?: {
        executionId: string;
        generation: number;
        expectedRevision: number;
        lease: ExecutionLeaseClaim;
        requestId: string;
    };
}
export type NextReasonCode = 'DISPATCHED' | 'SESSION_NOT_FOUND' | 'SESSION_AMBIGUOUS' | 'SESSION_NOT_RUNNING' | 'RESUME_REQUIRED' | 'LEASE_CONFLICT' | 'RUNNING_STEP' | 'DECISION_REQUIRED' | 'CHAIN_COMPLETE' | 'PICK_NOT_FOUND' | 'PICK_NOT_PENDING' | 'PICK_DECISION_NODE' | 'COMMAND_CONTENT_MISSING' | 'ARGUMENT_REQUIRED' | 'ARGUMENT_INVALID' | 'INTERNAL_ERROR';
export interface NextOutcome {
    exitCode: number;
    reasonCode: NextReasonCode;
    /** Structured result on success (exit 0); null otherwise. */
    result: NextResult | null;
    /** Rendered stdout/stderr text (birth packet on success, message otherwise). */
    message: string;
}
export declare function runNextStep(projectRoot: string, opts?: NextCmdOptions): NextOutcome;
export interface NextExecutionOptions extends Omit<NextCmdOptions, 'execution'> {
    sessionId: string;
    executionId: string;
    generation: number;
    expectedExecutionRevision: number;
    executionLease: ExecutionLeaseClaim;
    requestId: string;
}
/** Execution-aware next; all legacy runNextStep callers remain unchanged. */
export declare function runNextExecutionStep(projectRoot: string, options: NextExecutionOptions): NextOutcome;
//# sourceMappingURL=next.d.ts.map