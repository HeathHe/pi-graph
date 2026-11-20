import type { ContinuationDirective } from './protocol-schemas.js';
import { type ExecutionState } from './schemas.js';
import type { ResolvedSession } from './session-resolver.js';
import { type RecoveryBlocker, type RecoveryNext } from './session-transition.js';
export interface SessionStatusSummary {
    session_id: string;
    status: ResolvedSession['bundle']['session']['status'];
    engine: ResolvedSession['bundle']['session']['orchestration']['engine'];
    intent: string;
    progress: {
        terminal: number;
        total: number;
        pending: number;
    };
    active_step: null | {
        index: number;
        step_id: string;
        command: string;
        status: string;
        run_id: string | null;
        decision_ref: string | null;
    };
    active_run_id: string | null;
    latest_completed_run_id: string | null;
    revisions: {
        identity: number;
        activity: number;
    };
    recovery: {
        blockers: RecoveryBlocker[];
        can_resume: boolean;
        next: RecoveryNext;
    };
    position: ResolvedSession['bundle']['session']['orchestration']['position'];
    decomposition: ResolvedSession['bundle']['session']['orchestration']['decomposition'];
    registry: {
        artifacts: number;
        evidence: number;
        gates: number;
    };
    continuation: ContinuationDirective;
}
export interface SessionStatusV20Summary {
    schema_version: 'session/2.0';
    session_id: string;
    intent: string;
    archived_at: string | null;
    archived_by: string | null;
    current_execution_id: string | null;
    latest_execution_id: string | null;
    latest_completed_run_id: string | null;
    derived: {
        availability: 'available' | 'archived';
        execution_status: ExecutionState['status'] | null;
        active_run_id: string | null;
    };
    progress: {
        terminal: number;
        total: number;
        pending: number;
    };
    revisions: {
        identity: number;
        activity: number;
    };
    registry: {
        artifacts: number;
        evidence: number;
        gates: number;
    };
}
export type SessionStatusView = SessionStatusSummary | SessionStatusV20Summary;
export declare function summarizeSession(projectRoot: string, resolved: ResolvedSession): SessionStatusView;
//# sourceMappingURL=session-status.d.ts.map