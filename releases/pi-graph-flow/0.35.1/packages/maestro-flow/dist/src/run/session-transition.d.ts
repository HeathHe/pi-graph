import { type LeaseClaim } from './lease.js';
import { type SessionTransition } from './protocol-schemas.js';
import type { SessionArchiveReceipt } from './protocol-schemas.js';
import { type SessionIdentityV20, type SessionState } from './schemas.js';
export type ResolutionTarget = {
    kind: 'decision';
    id: string;
    disposition: 'proceed' | 'retry';
} | {
    kind: 'step';
    id: string;
    disposition: 'retry' | 'skip';
};
export interface SessionTransitionOptions {
    requestId: string;
    actor: string;
    reason: string;
    evidence: string[];
    expectedIdentityRevision: number;
    expectedActivityRevision: number;
    /** Optional concurrency fence; when present the complete lease triple is required. */
    leaseClaim?: LeaseClaim;
}
export interface ResolveSessionOptions extends SessionTransitionOptions {
    target: ResolutionTarget;
}
export type RecoveryBlocker = {
    kind: 'decision';
    id: string;
    status: 'escalated';
    dispositions: ['proceed', 'retry'];
} | {
    kind: 'step';
    id: string;
    status: 'failed';
    command: string;
    run_id: string | null;
    dispositions: ['retry', 'skip'];
};
export interface RecoveryNext {
    suggest_only: true;
    command: string | null;
    reason: string;
}
export declare function listRecoveryBlockers(session: SessionState): RecoveryBlocker[];
export declare function nextRecoveryAction(session: SessionState): RecoveryNext;
export interface SessionArchiveOptions {
    requestId: string;
    actor: string;
    reason: string;
    evidence: string[];
    expectedIdentityRevision: number;
    expectedActivityRevision: number;
    now?: Date;
}
export interface SessionArchiveResult {
    session: SessionIdentityV20;
    receipt: SessionArchiveReceipt;
    replayed: boolean;
}
export declare function archiveSession(projectRoot: string, sessionId: string, options: SessionArchiveOptions): SessionArchiveResult;
export declare function unarchiveSession(projectRoot: string, sessionId: string, options: SessionArchiveOptions): SessionArchiveResult;
export declare function resolveSession(projectRoot: string, sessionId: string, options: ResolveSessionOptions): SessionTransition;
export declare function resumeSession(projectRoot: string, sessionId: string, options: SessionTransitionOptions): SessionTransition;
//# sourceMappingURL=session-transition.d.ts.map