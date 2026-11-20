import { type DispatchExpectation, type RunCheckpoint } from './schemas.js';
export interface RegisterDispatchInput {
    chain_step_id: string;
    team_task_id: string;
    revision?: number;
    dispatched_at?: string;
}
/** Register the checkpoint identity before a worker is dispatched. */
export declare function registerDispatchExpectation(projectRoot: string, runId: string, input: RegisterDispatchInput, sessionId?: string): DispatchExpectation;
export interface RecordCheckpointInput {
    run_id: string;
    chain_step_id: string;
    team_task_id: string;
    revision: number;
    artifact_id: string | null;
    verdict: RunCheckpoint['verdict'];
    updated_at?: string;
}
/**
 * Validate a checkpoint against dispatch identity and ArtifactRegistry authority.
 * Null-artifact observations are retained but cannot claim a passing verdict.
 */
export declare function recordRunCheckpoint(projectRoot: string, runId: string, input: RecordCheckpointInput, sessionId?: string): RunCheckpoint;
//# sourceMappingURL=checkpoint.d.ts.map