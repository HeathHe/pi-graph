export declare const RUN_STATUSES: readonly ["pending", "running", "blocked", "completed", "failed", "cancelled", "sealed"];
export type RunStatus = typeof RUN_STATUSES[number];
export declare const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>>;
export interface RunTransitionEvidence {
    reason?: string;
    evidence?: readonly string[];
}
export interface RunStateSnapshot {
    status: RunStatus;
}
export type RunVerdict = 'done' | 'done_with_concerns' | 'needs_retry' | 'blocked';
interface RetrySourceRunBase {
    runId: string;
    attempt: number;
}
export type RetrySourceRun = RetrySourceRunBase & ({
    status: Exclude<RunStatus, 'sealed'>;
    verdict?: never;
} | {
    status: 'sealed';
    verdict: RunVerdict | null;
});
export interface RetryMetadata {
    retryOfRunId: string;
    attempt: number;
}
export declare function assertRunTransition(from: RunStatus, to: RunStatus, context?: RunTransitionEvidence): void;
export declare function canRunTransition(from: RunStatus, to: RunStatus, context?: RunTransitionEvidence): boolean;
export declare function transitionRun<T extends RunStateSnapshot, S extends RunStatus>(run: T, to: S, context?: RunTransitionEvidence): Omit<T, 'status'> & {
    status: S;
};
export declare function assertRetrySource(run: RetrySourceRun): void;
export declare function buildRetryMetadata(run: RetrySourceRun): RetryMetadata;
export {};
//# sourceMappingURL=run-machine.d.ts.map