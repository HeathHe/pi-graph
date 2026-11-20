import { type PersistedTransitionRecord, type PersistedTransitionRecordV11, type TransitionFence, type TransitionFenceV11, type TransitionOutcome, type TransitionOutcomeV11, type TransitionRequest, type TransitionRequestV11 } from './protocol-schemas.js';
import type { LeaseClaim } from './lease.js';
import type { SessionState } from './schemas.js';
export interface TransitionMutationOptions {
    requestId: string;
    expectedIdentityRevision: number;
    expectedActivityRevision: number;
    leaseClaim?: LeaseClaim;
}
export interface TransitionMutationReceipt {
    request_id: string;
    transition_id: string;
    status: 'applied' | 'replayed';
}
export type TransitionMutationResult<T> = T & {
    transition: TransitionMutationReceipt;
};
export interface PreparedTransitionMutation {
    request: TransitionRequest;
    options: TransitionMutationOptions;
}
export declare function stableJsonUtf8(value: unknown): string;
export declare function sha256Digest(value: string | Buffer): string;
export declare function normalizedTransitionRequestHash(request: Omit<TransitionRequest, 'normalized_request_hash'>): string;
export declare function createTransitionRequest(input: Omit<TransitionRequest, 'schema_version' | 'normalized_request_hash'>): TransitionRequest;
export declare class TransitionReceiptError extends Error {
    readonly code: 'REQUEST_CONFLICT' | 'REPLAY_STATE_DIVERGED' | 'INVALID_TRANSITION_RECEIPT' | 'FENCE_CONFLICT' | 'ALREADY_ACCEPTED';
    constructor(code: 'REQUEST_CONFLICT' | 'REPLAY_STATE_DIVERGED' | 'INVALID_TRANSITION_RECEIPT' | 'FENCE_CONFLICT' | 'ALREADY_ACCEPTED', message: string);
}
/**
 * Prepare one normalized retryable mutation request. Existing receipts supply
 * their original timestamp, precondition fence and omitted guard values so a
 * caller may retry with only the same request ID without changing its hash.
 */
export declare function prepareTransitionMutation(input: {
    session: SessionState;
    currentFence: TransitionFence;
    operation: TransitionRequest['operation'];
    subject: TransitionRequest['subject'];
    payload: Record<string, unknown>;
    options?: Partial<TransitionMutationOptions>;
}): PreparedTransitionMutation;
export declare function assertTransitionMutationRevisions(session: SessionState, options: TransitionMutationOptions): void;
export declare function transitionMutationReceipt(request: TransitionRequest, outcome: TransitionOutcome, replayed: boolean): TransitionMutationReceipt;
export declare function validatePersistedTransitionRecord(recordInput: unknown): PersistedTransitionRecord;
export interface ReplayOrApplyTransitionResult {
    outcome: TransitionOutcome;
    record: PersistedTransitionRecord;
    replayed: boolean;
}
/**
 * Pure replay gate. The caller owns the lock and persists `record` only when
 * `replayed` is false. Similarity/recall data is intentionally absent here.
 */
export declare function replayOrApplyTransition(records: readonly PersistedTransitionRecord[], requestInput: TransitionRequest, currentFence: TransitionFence, apply: () => TransitionOutcome, validateReplay?: (record: PersistedTransitionRecord) => void): ReplayOrApplyTransitionResult;
export declare function createTransitionOutcome(input: Omit<TransitionOutcome, 'schema_version' | 'transition_id' | 'result_hash'> & {
    transition_id?: string;
}): TransitionOutcome;
export declare function createTransitionRequestV11(input: Omit<TransitionRequestV11, 'schema_version' | 'normalized_request_hash'>): TransitionRequestV11;
export declare function createTransitionOutcomeV11(input: Omit<TransitionOutcomeV11, 'schema_version' | 'transition_id' | 'result_hash'> & {
    transition_id?: string;
}): TransitionOutcomeV11;
export declare function validatePersistedTransitionRecordV11(value: unknown): PersistedTransitionRecordV11;
export declare function replayOrApplyTransitionV11(records: readonly PersistedTransitionRecordV11[], requestInput: TransitionRequestV11, currentFence: TransitionFenceV11, apply: () => TransitionOutcomeV11, validateReplay?: (record: PersistedTransitionRecordV11, records: readonly PersistedTransitionRecordV11[], currentFence: TransitionFenceV11) => void): {
    outcome: TransitionOutcomeV11;
    record: PersistedTransitionRecordV11;
    replayed: boolean;
};
export { persistedTransitionRecordSchema, transitionOutcomeSchema, transitionRequestSchema, type PersistedTransitionRecord, type TransitionFence, type TransitionOutcome, type TransitionRequest, } from './protocol-schemas.js';
//# sourceMappingURL=transition-receipts.d.ts.map