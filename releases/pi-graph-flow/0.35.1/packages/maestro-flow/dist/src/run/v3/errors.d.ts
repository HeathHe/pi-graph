import { type RunResponseErrorCodeV12, type RunResponseV12, type TransitionReceiptV20 } from '../protocol-schemas.js';
export type V3ErrorCode = RunResponseErrorCodeV12;
export type V3TransitionTargetType = TransitionReceiptV20['target_type'];
export type RunResponseV12ErrorDetail = NonNullable<RunResponseV12['error']>;
export interface V3StructuredErrorDetails {
    retryable?: boolean;
    details?: Readonly<Record<string, unknown>>;
    target_type?: V3TransitionTargetType | null;
    target_id?: string | null;
    expected_revision?: number | null;
    current_revision?: number | null;
    changed_by?: string | null;
    next_actions?: readonly string[];
}
export type V3StructuredErrorPayload = RunResponseV12ErrorDetail;
export declare class V3StructuredError extends Error {
    readonly code: V3ErrorCode;
    readonly retryable: boolean;
    readonly details: Readonly<Record<string, unknown>>;
    readonly target_type: V3TransitionTargetType | null;
    readonly target_id: string | null;
    readonly expected_revision: number | null;
    readonly current_revision: number | null;
    readonly changed_by: string | null;
    readonly next_actions: readonly string[];
    constructor(code: V3ErrorCode, message: string, details?: V3StructuredErrorDetails);
    toRunResponseV12ErrorDetail(): RunResponseV12ErrorDetail;
    toJSON(): V3StructuredErrorPayload;
}
export declare function createRevisionConflictError(input: {
    code: Extract<V3ErrorCode, 'RUN_REVISION_CONFLICT' | 'ORCHESTRATION_REVISION_CONFLICT'>;
    targetType: Extract<V3TransitionTargetType, 'run' | 'orchestration'>;
    targetId: string;
    expectedRevision: number;
    currentRevision: number;
    changedBy: string;
    nextActions?: readonly string[];
}): V3StructuredError;
export declare function createRequestConflictError(input: {
    requestId: string;
    changedBy?: string;
    nextActions?: readonly string[];
}): V3StructuredError;
export declare function createSessionAmbiguousError(input: {
    candidateSessionIds: readonly string[];
    source?: string | null;
    nextActions?: readonly string[];
}): V3StructuredError;
export declare function createSessionSchemaUnsupportedError(input: {
    sessionId: string;
    schemaVersion: string;
    nextActions?: readonly string[];
}): V3StructuredError;
//# sourceMappingURL=errors.d.ts.map