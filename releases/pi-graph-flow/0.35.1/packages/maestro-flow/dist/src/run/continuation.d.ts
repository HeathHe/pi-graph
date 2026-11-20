import { type ContinuationDirective } from './protocol-schemas.js';
import type { ReuseAssessment } from './reuse-assessment.js';
import type { CommandRun, SessionState } from './schemas.js';
export interface InspectContinuationOptions {
    runId?: string | null;
}
export interface LifecycleNext {
    command: string | null;
    reason: string;
}
export declare function reuseAcceptanceStatus(session: SessionState, run: CommandRun, assessment: ReuseAssessment): NonNullable<ContinuationDirective['assessment']>['acceptance_status'];
export declare function inspectSessionContinuation(projectRoot: string, sessionId: string, options?: InspectContinuationOptions): ContinuationDirective;
export declare function continuationAfterBrief(projectRoot: string, sessionId: string, runId: string, next: LifecycleNext): ContinuationDirective;
export declare function continuationAfterCheck(projectRoot: string, sessionId: string, runId: string, clean: boolean, next: LifecycleNext): ContinuationDirective;
export declare function continuationAfterDecide(projectRoot: string, sessionId: string, pointId: string, verdict: 'proceed' | 'fix' | 'escalate', retry: {
    count: number;
    max: number;
    exhausted: boolean;
} | null): ContinuationDirective;
export declare function continuationForNextFailure(projectRoot: string, sessionId: string | undefined, reasonCode: string, message: string): ContinuationDirective | null;
export declare function renderContinuationCard(value: ContinuationDirective): string;
//# sourceMappingURL=continuation.d.ts.map