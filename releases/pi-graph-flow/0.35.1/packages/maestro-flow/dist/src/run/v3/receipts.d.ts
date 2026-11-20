import type { SessionV30StoreTransaction, SessionStore } from '../store.js';
import { type RequestReceiptV20, type TransitionReceiptV20 } from '../protocol-schemas.js';
export interface TransitionReceiptLocator {
    activityRevision: number;
    transitionId: string;
}
export interface TransitionReceiptReader {
    readTransitionReceipt(activityRevision: number, transitionId: string): TransitionReceiptV20 | null;
}
export declare function canonicalPayloadHash(payload: unknown): string;
export declare function transitionReceiptRef(activityRevision: number, transitionId: string): string;
export declare function parseTransitionReceiptRef(reference: string): TransitionReceiptLocator;
export declare function readTransitionReceiptRef(reader: TransitionReceiptReader, reference: string): TransitionReceiptV20;
export declare function readStoredTransitionReceiptRef(store: Pick<SessionStore, 'readTransitionReceiptV20'>, sessionId: string, reference: string): TransitionReceiptV20;
export declare function createRequestReceipt(input: {
    requestId: string;
    participantId: string;
    payloadHash: string;
    transitionReceiptRef: string;
}): RequestReceiptV20;
export declare function createTransitionReceipt(input: {
    transitionId: string;
    requestId: string;
    sessionId: string;
    activityRevision: number;
    targetType: TransitionReceiptV20['target_type'];
    targetId: string;
    revisionBefore: number;
    revisionAfter: number;
    actorId: string;
    participantId: string;
    reason: string;
    evidenceRefs?: readonly string[];
    recordedAt: string;
    result: unknown;
}): TransitionReceiptV20;
export declare function replayRequestReceipt(input: {
    tx: Pick<SessionV30StoreTransaction, 'readRequestReceipt' | 'readTransitionReceipt'>;
    sessionId?: string;
    requestId: string;
    participantId: string;
    payloadHash: string;
}): TransitionReceiptV20 | null;
//# sourceMappingURL=receipts.d.ts.map