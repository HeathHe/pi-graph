import { type RecallConfirmationRecord } from './protocol-schemas.js';
export interface RecallActionRequest {
    action: RecallConfirmationRecord['action'];
    target_session_id: string;
    command: string;
    intent: string;
    source_session_id?: string | null;
    source_run_id?: string | null;
    source_workspace?: string | null;
    args?: string[];
}
export declare function recallActionRequestHash(input: RecallActionRequest): string;
export declare function issueRecallConfirmation(projectRoot: string, input: RecallActionRequest): {
    token: string;
    record: RecallConfirmationRecord;
};
//# sourceMappingURL=recall-confirmation.d.ts.map