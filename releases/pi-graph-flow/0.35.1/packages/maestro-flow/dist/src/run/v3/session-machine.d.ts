import { type RunStatus, type RunTransitionEvidence } from './run-machine.js';
export declare const SESSION_STATUSES: readonly ["open", "completed", "archived", "failed"];
export type SessionStatus = typeof SESSION_STATUSES[number];
export declare const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>>;
export type SessionOperation = 'create_run' | 'advance_chain' | 'transition_run' | 'add_evidence' | 'decide';
export declare const SESSION_OPERATION_PERMISSIONS: Readonly<Record<SessionStatus, readonly SessionOperation[]>>;
export interface SessionStateSnapshot {
    status: SessionStatus;
}
export interface SessionRunOperationContext {
    runStatus?: RunStatus;
    nextRunStatus?: RunStatus;
}
export interface SessionCompletionRun {
    runId: string;
    status: RunStatus;
}
export interface SessionCompletionGate {
    gateId: string;
    status: string;
}
export interface SessionCompletionStep {
    stepId: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    skipEvidence?: readonly string[];
}
export interface SessionCompletionSnapshot {
    runs: readonly SessionCompletionRun[];
    blockingGates: readonly SessionCompletionGate[];
    requiredSteps: readonly SessionCompletionStep[];
    /** Decision gates declared on chain steps (step.decision_ref → decisions[] status). */
    decisionGates: readonly SessionCompletionGate[];
}
export type SessionCompletionBlocker = {
    kind: 'running_run';
    id: string;
    message: string;
} | {
    kind: 'blocking_gate';
    id: string;
    message: string;
} | {
    kind: 'required_step';
    id: string;
    message: string;
} | {
    kind: 'open_decision_gate';
    id: string;
    message: string;
};
export declare function assertSessionOperationAllowed(status: SessionStatus, operation: SessionOperation, context?: SessionRunOperationContext): void;
export declare function assertSessionRunTransitionAllowed(sessionStatus: SessionStatus, from: RunStatus, to: RunStatus, evidence?: RunTransitionEvidence): void;
export declare function listSessionCompletionBlockers(snapshot: SessionCompletionSnapshot): SessionCompletionBlocker[];
export declare function assertSessionCanComplete(snapshot: SessionCompletionSnapshot): void;
export declare function assertSessionTransition(from: SessionStatus, to: SessionStatus, completion?: SessionCompletionSnapshot): void;
export declare function transitionSession<T extends SessionStateSnapshot, S extends SessionStatus>(session: T, to: S, completion?: SessionCompletionSnapshot): Omit<T, 'status'> & {
    status: S;
};
//# sourceMappingURL=session-machine.d.ts.map