import { type RecallActionRequest } from './recall-confirmation.js';
import { type ImportManifest } from './protocol-schemas.js';
export interface ExecuteRecallActionInput extends RecallActionRequest {
    confirmation_token: string;
}
export interface ExecuteRecallActionOptions {
    now?: Date;
    reservationTtlMs?: number;
    afterClaim?: () => void;
    afterArtifactCopy?: (index: number) => void;
    afterCreate?: () => void;
}
export interface RecallActionResult {
    action: 'fork' | 'import' | 'new';
    session_id: string;
    run_id: string;
    run_dir: string;
    import_manifest: ImportManifest | null;
    replayed: boolean;
    reservation_id: string;
}
export declare function executeRecallAction(projectRoot: string, input: ExecuteRecallActionInput, options?: ExecuteRecallActionOptions): RecallActionResult;
//# sourceMappingURL=recall-actions.d.ts.map