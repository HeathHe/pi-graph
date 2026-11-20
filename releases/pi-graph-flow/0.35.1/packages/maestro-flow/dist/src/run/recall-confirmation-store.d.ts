import { type RecallConfirmationFinalTarget, type RecallConfirmationOutcome, type RecallConfirmationRecord, type RecallConfirmationRegistry, type RecallConfirmationTargetIdentity, type RecallReservationMarker, type StaleRecallReservation } from './protocol-schemas.js';
export declare const RECALL_CONFIRMATION_TTL_MS = 600000;
export declare const RECALL_CONFIRMATION_RESERVATION_TTL_MS = 120000;
export declare const RECALL_CONFIRMATION_RECONCILIATION_TTL_MS = 120000;
export declare function createRecallConfirmationRegistry(): RecallConfirmationRegistry;
export interface IssueRecallConfirmationInput {
    action: RecallConfirmationRecord['action'];
    candidate_id?: string | null;
    request_hash: string;
    source_fence?: RecallConfirmationRecord['source_fence'];
    target_fence: RecallConfirmationRecord['target_fence'];
    target_session_id: string;
    now?: Date;
    ttl_ms?: number;
}
export declare function issueRecallConfirmationRecord(input: IssueRecallConfirmationInput): {
    token: string;
    record: RecallConfirmationRecord;
};
export declare class RecallConfirmationError extends Error {
    readonly code: 'TOKEN_INVALID' | 'TOKEN_EXPIRED' | 'TOKEN_REPLAYED' | 'TOKEN_RESERVED' | 'REQUEST_CONFLICT' | 'FENCE_CONFLICT' | 'RESERVATION_INVALID';
    constructor(code: 'TOKEN_INVALID' | 'TOKEN_EXPIRED' | 'TOKEN_REPLAYED' | 'TOKEN_RESERVED' | 'REQUEST_CONFLICT' | 'FENCE_CONFLICT' | 'RESERVATION_INVALID', message: string);
}
export declare function assertRecallConfirmationConsumable(recordInput: RecallConfirmationRecord, expected: {
    action: RecallConfirmationRecord['action'];
    request_hash: string;
    now?: Date;
}): RecallConfirmationRecord;
export declare function createRecallReservationMarker(reservation: NonNullable<RecallConfirmationRecord['reservation']>): RecallReservationMarker;
export declare function createStaleRecallReservation(reservation: NonNullable<RecallConfirmationRecord['reservation']>): StaleRecallReservation;
export interface ReserveRecallConfirmationInput {
    action: RecallConfirmationRecord['action'];
    request_hash: string;
    source_fence: RecallConfirmationRecord['source_fence'];
    target_fence: RecallConfirmationRecord['target_fence'];
    proposed_target: RecallConfirmationTargetIdentity;
    now?: Date;
    reservation_ttl_ms?: number;
}
export type ReserveRecallConfirmationResult = {
    status: 'reserved';
    record: RecallConfirmationRecord;
    reservation_id: string;
    rollback_target: RecallConfirmationTargetIdentity;
    marker: RecallReservationMarker;
} | {
    status: 'replayed';
    record: RecallConfirmationRecord;
    reservation_id: null;
    outcome: RecallConfirmationOutcome;
} | {
    status: 'stale';
    record: RecallConfirmationRecord;
    reservation_id: string;
    stale: StaleRecallReservation;
    rollback_target: RecallConfirmationTargetIdentity;
    marker: RecallReservationMarker;
};
export declare function reserveRecallConfirmationRecord(recordInput: RecallConfirmationRecord, input: ReserveRecallConfirmationInput): ReserveRecallConfirmationResult;
export interface FinalizeRecallConfirmationInput {
    action: RecallConfirmationRecord['action'];
    request_hash: string;
    target: RecallConfirmationFinalTarget;
    target_hash: string;
    outcome: Record<string, unknown>;
    now?: Date;
}
export declare function finalizeRecallConfirmationRecord(recordInput: RecallConfirmationRecord, reservationId: string, input: FinalizeRecallConfirmationInput): {
    record: RecallConfirmationRecord;
    outcome: RecallConfirmationOutcome;
    replayed: boolean;
};
export declare function cancelRecallConfirmationRecord(recordInput: RecallConfirmationRecord, reservationId: string, now?: Date): {
    record: RecallConfirmationRecord;
    rollback_target: RecallConfirmationTargetIdentity;
    released: boolean;
};
export declare function hashRecallConfirmationToken(token: string): string;
export { recallConfirmationFinalTargetSchema, recallConfirmationOutcomeSchema, recallConfirmationRecordReadSchema, recallConfirmationRecordSchema, recallConfirmationRecordV11Schema, recallConfirmationRegistryReadSchema, recallConfirmationRegistrySchema, recallConfirmationRegistryV11Schema, recallConfirmationReservationReadSchema, recallConfirmationReservationSchema, recallConfirmationReservationV11Schema, recallConfirmationTargetIdentitySchema, recallReservationMarkerSchema, staleRecallReservationSchema, type RecallConfirmationFinalTarget, type RecallConfirmationOutcome, type RecallConfirmationRecord, type RecallConfirmationRegistry, type RecallConfirmationTargetIdentity, type RecallReservationMarker, type StaleRecallReservation, } from './protocol-schemas.js';
//# sourceMappingURL=recall-confirmation-store.d.ts.map