import type { ArtifactRegistry, EvidenceStore, ExecutionState, GateRegistry, SessionIdentityV20, SessionSchemaSelection, SessionState } from './schemas.js';
import type { IntentIdentity, SessionProvenance, TopicIdentityProtocol } from './protocol-schemas.js';
export declare const DEFAULT_SESSION_SCHEMA_SELECTION: SessionSchemaSelection;
export declare function createSessionState(sessionId: string, intent: string, options?: {
    intentIdentity?: IntentIdentity | null;
    provenance?: SessionProvenance;
}): SessionState;
export declare function createSessionIdentityV20(sessionId: string, intent: string, options?: {
    topicIdentity?: TopicIdentityProtocol | null;
    identityRevision?: number;
    activityRevision?: number;
    currentExecutionId?: string | null;
    latestExecutionId?: string | null;
    latestCompletedRunId?: string | null;
    archivedAt?: string | null;
    archivedBy?: string | null;
}): SessionIdentityV20;
export declare function createGateRegistry(): GateRegistry;
export declare function createArtifactRegistry(): ArtifactRegistry;
export declare function createEvidenceStore(): EvidenceStore;
/**
 * Create the additive execution/1.0 projection for an existing Session. The
 * legacy Session remains authoritative for compatibility callers and is not
 * mutated by this projection.
 */
export declare function createExecutionState(session: SessionState, options: {
    executionId: string;
    generation: number;
    startedAt: string;
}): ExecutionState;
//# sourceMappingURL=defaults.d.ts.map