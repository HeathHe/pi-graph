import { z } from 'zod';
import { type ArtifactRegistry, type CommandRunInput, type EvidenceStore, type ExecutionState, type GateRegistry, type RunV30, type SessionIdentityV20, type SessionState, type SessionStateV30 } from '../schemas.js';
import { type PersistedTransitionRecordV11, type TransitionReceiptV20 } from '../protocol-schemas.js';
import { SessionStore } from '../store.js';
type LegacySession = SessionState | SessionIdentityV20;
export declare const migrationReportV1Schema: z.ZodObject<{
    schema_version: z.ZodLiteral<"session-v3-migration-report/1.0">;
    migration_id: z.ZodString;
    session_id: z.ZodString;
    source_session_schema: z.ZodEnum<{
        "session/1.3": "session/1.3";
        "session/2.0": "session/2.0";
    }>;
    source_execution_schema: z.ZodNullable<z.ZodLiteral<"execution/1.0">>;
    source_run_schemas: z.ZodArray<z.ZodEnum<{
        "command-run/1.0": "command-run/1.0";
        "command-run/1.1": "command-run/1.1";
        "command-run/1.2": "command-run/1.2";
        "command-run/1.3": "command-run/1.3";
        "command-run/1.4": "command-run/1.4";
    }>>;
    target_session_schema: z.ZodLiteral<"session/3.0">;
    target_run_schema: z.ZodLiteral<"run/3.0">;
    recorded_at: z.ZodString;
    source_status_signal: z.ZodString;
    target_status: z.ZodEnum<{
        completed: "completed";
        failed: "failed";
        archived: "archived";
        open: "open";
    }>;
    hash_scope: z.ZodLiteral<"sha256 of supplied source bytes; otherwise sha256 of stable canonical JSON UTF-8 input">;
    source_snapshots: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            artifacts: "artifacts";
            session: "session";
            evidence: "evidence";
            gates: "gates";
            run: "run";
            execution: "execution";
            "execution-transition": "execution-transition";
            "retired-state": "retired-state";
        }>;
        source_id: z.ZodString;
        sha256: z.ZodString;
        hash_basis: z.ZodEnum<{
            "source-bytes": "source-bytes";
            "canonical-json-v1": "canonical-json-v1";
        }>;
    }, z.core.$strict>>;
    retired_execution_transitions: z.ZodArray<z.ZodObject<{
        source_id: z.ZodString;
        disposition: z.ZodEnum<{
            "projected-v3-receipt": "projected-v3-receipt";
            "retained-read-only": "retained-read-only";
        }>;
        projected_transition_id: z.ZodNullable<z.ZodString>;
        projected_activity_revision: z.ZodNullable<z.ZodNumber>;
        reason: z.ZodString;
    }, z.core.$strict>>;
    discarded_private_state: z.ZodArray<z.ZodObject<{
        sha256: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strict>>;
    references: z.ZodObject<{
        validated: z.ZodLiteral<true>;
        run_count: z.ZodNumber;
        chain_step_count: z.ZodNumber;
        gate_count: z.ZodNumber;
        artifact_count: z.ZodNumber;
        evidence_count: z.ZodNumber;
    }, z.core.$strict>;
    publication: z.ZodObject<{
        api: z.ZodLiteral<"SessionStore.withV30Transaction">;
        atomic: z.ZodLiteral<true>;
        dual_write: z.ZodLiteral<false>;
        legacy_execution_storage: z.ZodLiteral<"retained-read-only">;
        legacy_snapshot_root: z.ZodString;
        legacy_snapshot_manifest_hash: z.ZodString;
    }, z.core.$strict>;
    target_hashes: z.ZodObject<{
        session: z.ZodString;
        runs: z.ZodRecord<z.ZodString, z.ZodString>;
        transition_receipt: z.ZodString;
        legacy_transition_receipts: z.ZodRecord<z.ZodString, z.ZodString>;
        projection: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type V3MigrationReport = z.infer<typeof migrationReportV1Schema>;
export interface LegacyMigrationSourceBytes {
    session?: string | Buffer;
    execution?: string | Buffer;
    execution_transitions?: Readonly<Record<string, string | Buffer>>;
    runs?: Readonly<Record<string, string | Buffer>>;
    gates?: string | Buffer;
    artifacts?: string | Buffer;
    evidence?: string | Buffer;
}
export interface RetiredLegacyState {
    source_id: string;
    value: unknown;
    reason: string;
}
export interface LegacyV3MigrationInput {
    session: LegacySession;
    execution?: ExecutionState | null;
    execution_transitions?: readonly PersistedTransitionRecordV11[];
    runs: readonly CommandRunInput[];
    gates: GateRegistry;
    artifacts: ArtifactRegistry;
    evidence: EvidenceStore;
    source_bytes?: LegacyMigrationSourceBytes;
    retired_state?: readonly RetiredLegacyState[];
}
export interface V3MigrationOptions {
    actor_id?: string;
    recorded_at?: string;
    definition_of_done?: string;
    expected_identity_revision?: number;
    expected_activity_revision?: number;
    /** Migration audit identity (H3/⑨): a request receipt links the migration
     * transition to the caller's request for replay/idempotency parity with
     * regular v3 mutations. When omitted (e.g. programmatic callers) a
     * synthesized request id is used so the request-receipt chain is always
     * present. */
    request_id?: string;
    reason?: string;
    evidence_refs?: string[];
}
export interface V3MigrationProjection {
    session: SessionStateV30;
    runs: RunV30[];
    transition_receipt: TransitionReceiptV20;
    legacy_transition_receipts: TransitionReceiptV20[];
    report: V3MigrationReport;
}
export interface V3MigrationApplyResult extends V3MigrationProjection {
    status: 'applied' | 'already-applied';
    report_path: string;
}
export type V3MigrationErrorCode = 'MIGRATION_INPUT_INVALID' | 'MIGRATION_RUNNING_RUN' | 'MIGRATION_REFERENCE_INTEGRITY' | 'MIGRATION_SOURCE_CHANGED' | 'MIGRATION_CONFLICT';
export declare class V3MigrationError extends Error {
    readonly code: V3MigrationErrorCode;
    constructor(code: V3MigrationErrorCode, message: string);
}
/** Ordered mapping table. The first matching signal is authoritative. */
export declare const V3_MIGRATION_STATUS_MAPPING: readonly [{
    readonly signal: "session-archived";
    readonly target: "archived";
}, {
    readonly signal: "execution-paused";
    readonly target: "open";
}, {
    readonly signal: "execution-sealed-done";
    readonly target: "completed";
}, {
    readonly signal: "execution-sealed-done_with_concerns";
    readonly target: "completed";
}, {
    readonly signal: "execution-sealed-failed";
    readonly target: "failed";
}, {
    readonly signal: "execution-active";
    readonly target: "open";
}, {
    readonly signal: "legacy-session-paused";
    readonly target: "open";
}, {
    readonly signal: "legacy-session-sealed";
    readonly target: "completed";
}, {
    readonly signal: "legacy-session-failed";
    readonly target: "failed";
}, {
    readonly signal: "no-execution-or-legacy-running";
    readonly target: "open";
}];
/** Pure, deterministic projection. It performs no filesystem writes or clock reads. */
export declare function projectLegacySessionToV30(rawInput: LegacyV3MigrationInput, options?: V3MigrationOptions): V3MigrationProjection;
export declare function v3MigrationReportPath(store: SessionStore, sessionId: string): string;
/**
 * Controlled legacy replacement entry point. Normal writeSessionV30/writeRunV30
 * guards remain intact; only this validated W5 path uses the W1 transaction's
 * migration-capable batch to replace legacy authority atomically.
 */
export declare function readAppliedV3Migration(store: SessionStore, sessionId: string): V3MigrationApplyResult;
export declare function applyV3Migration(store: SessionStore, input: LegacyV3MigrationInput, options?: V3MigrationOptions): V3MigrationApplyResult;
export {};
//# sourceMappingURL=migrate-v3.d.ts.map