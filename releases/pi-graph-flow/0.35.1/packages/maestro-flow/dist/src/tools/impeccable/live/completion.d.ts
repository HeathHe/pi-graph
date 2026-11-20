/**
 * Completion type mapping for Impeccable live-session accept results.
 */
export type EventType = string;
export interface AcceptResult {
    handled?: boolean;
    carbonize?: boolean;
    mode?: string;
    error?: string;
    file?: string;
}
export type CompletionType = 'discarded' | 'error' | 'agent_done' | 'complete';
export interface CompletionAck {
    ok: boolean;
    type: CompletionType;
    final?: boolean;
    requiresComplete?: boolean;
    nextCommand?: string;
    message?: string;
    error?: string;
}
export declare function completionTypeForAcceptResult(eventType: EventType, acceptResult: AcceptResult | undefined): CompletionType;
export declare function completionAckForAcceptResult(eventId: string, completionType: CompletionType, acceptResult: AcceptResult | undefined): CompletionAck;
//# sourceMappingURL=completion.d.ts.map