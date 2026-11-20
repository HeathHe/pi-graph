import { SessionStore } from './store.js';
import type { SessionState } from './schemas.js';
export interface RunningStep {
    index: number;
    step_id: string;
    command: string;
    run_id: string;
}
/** The single running chain step that has a bound run_id, or null. */
export declare function runningChainStep(session: SessionState): RunningStep | null;
export type ResolveRunResult = {
    kind: 'ok';
    sessionId: string;
    session: SessionState;
    step: RunningStep;
} | {
    kind: 'error';
    message: string;
};
/**
 * Resolve the Run to complete when no run-id is supplied. Session resolution
 * order matches `run next`; within the session, the running chain step with a
 * run_id is the target. Errors list the candidates / point at passing a run-id.
 */
export declare function resolveRunningRun(projectRoot: string, store: SessionStore, sessionId?: string, verb?: string): ResolveRunResult;
export interface ActiveRunTarget {
    sessionId: string;
    runId: string;
}
/**
 * Resolve the active Run (single-Run sessions without a chain step) when no
 * run-id is supplied. Falls back after resolveRunningRun for commands whose
 * no-arg form also covers single-Run sessions.
 */
export declare function resolveActiveRunTarget(store: SessionStore, sessionId?: string, verb?: string): ActiveRunTarget | null;
//# sourceMappingURL=resolve.d.ts.map