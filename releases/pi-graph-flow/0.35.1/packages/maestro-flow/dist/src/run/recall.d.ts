import { type RunRecall, type RecallConfirmationRecord } from './protocol-schemas.js';
export interface RecallRequest {
    command: string;
    intent: string;
    topic?: string;
    limit?: number;
    asOf?: string;
    interactive?: boolean;
}
type SourceFence = NonNullable<RecallConfirmationRecord['source_fence']>;
export declare function buildSourceFence(projectRoot: string, sessionId: string, runId: string, workspaceLinkName?: string | null): SourceFence;
export declare function recallRuns(projectRoot: string, request: RecallRequest): Promise<RunRecall>;
export {};
//# sourceMappingURL=recall.d.ts.map