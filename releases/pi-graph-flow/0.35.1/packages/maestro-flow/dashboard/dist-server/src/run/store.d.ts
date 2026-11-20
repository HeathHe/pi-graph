import { z } from 'zod';
import { type ExecutionLeaseClaim } from './lease.js';
import { type ArtifactRegistry, type CommandRun, type CommandRunV14, type RunRead, type RunV30, type EvidenceStore, type ExecutionState, type GateRegistry, type SessionSchemaSelection, type SessionState, type SessionStateRead, type SessionStateV30, type SessionIdentityV20 } from './schemas.js';
import { type ArtifactRepublishReceipt, type ExecutionSealReceipt, type ExecutionSealReceiptV10, type ExecutionSealReceiptV11, type IntentIdentity, type RecallConfirmationFinalTarget, type RecallConfirmationOutcome, type RecallConfirmationRecord, type RecallConfirmationTargetIdentity, type RecallReservationMarker, type RecallReservationObservation, type RecallReservationReconciliation, type PersistedTransitionRecord, type PersistedTransitionRecordV11, type SessionArchiveReceipt, type RequestReceiptV20, type TransitionReceiptV20, type SessionProvenance, type TransitionFence, type TransitionOutcome, type TransitionRequest, type ValidatedRecallSource } from './protocol-schemas.js';
import { type FinalizeRecallConfirmationInput, type IssueRecallConfirmationInput, type ReserveRecallConfirmationInput, type ReserveRecallConfirmationResult } from './recall-confirmation-store.js';
export interface SessionBundle {
    session: SessionState;
    gates: GateRegistry;
    artifacts: ArtifactRegistry;
    evidence: EvidenceStore;
}
export interface SessionListFilters {
    statuses?: SessionState['status'][];
    engines?: SessionState['orchestration']['engine'][];
    intentIdentity?: IntentIdentity;
}
export interface SessionListCandidate {
    sessionId: string;
    session: SessionState;
    identity: IntentIdentity | null;
}
export interface SessionListExclusion {
    sessionId: string;
    code: 'CORRUPT' | 'STATUS_FILTERED' | 'ENGINE_FILTERED' | 'IDENTITY_MISMATCH' | 'IDENTITY_UNAVAILABLE';
    detail: string;
}
export interface SessionListResult {
    candidates: SessionListCandidate[];
    exclusions: SessionListExclusion[];
}
export interface LocatedRunRecord {
    sessionId: string;
    run: RunRead;
}
export type SessionStoreReserveRecallResult = ReserveRecallConfirmationResult & {
    validated_source: ValidatedRecallSource | null;
};
interface JsonWrite {
    path: string;
    value?: unknown;
    raw?: string;
    schema?: z.ZodType;
    mode?: number;
}
export interface SessionStoreLockTiming {
    now: () => number;
    wait: (milliseconds: number) => void;
}
export interface SessionStoreOptions {
    lockTiming?: Partial<SessionStoreLockTiming>;
}
export interface ExecutionAtomicOptions {
    replayRequestId?: string;
    expectedActivityRevision?: number;
}
export declare class SessionSchemaUnsupportedError extends Error {
    readonly sessionId: string;
    readonly code: "SESSION_SCHEMA_UNSUPPORTED";
    constructor(sessionId: string, detail?: string);
}
export interface ExecutionRunSidecarAuthority {
    executionId: string;
    generation: number;
    requestId: string;
    expectedExecutionRevision: number;
    lease: ExecutionLeaseClaim;
}
declare const executionRunSidecarReceiptSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"execution-run-sidecar-transition/1.0">;
    request_id: z.ZodString;
    operation: z.ZodEnum<{
        "knowledge-stage": "knowledge-stage";
        "knowledge-record": "knowledge-record";
    }>;
    session_id: z.ZodString;
    execution_id: z.ZodString;
    generation: z.ZodNumber;
    run_id: z.ZodString;
    sidecar_path: z.ZodString;
    expected_execution_revision: z.ZodNumber;
    lease: z.ZodObject<{
        owner_id: z.ZodString;
        owner_kind: z.ZodEnum<{
            codex: "codex";
            agy: "agy";
            pi: "pi";
            manual: "manual";
            claude: "claude";
        }>;
        epoch: z.ZodNumber;
        lease_id_hash: z.ZodString;
    }, z.core.$strict>;
    request_hash: z.ZodString;
    sidecar_revision_before: z.ZodNumber;
    sidecar_revision_after: z.ZodNumber;
    applied_at: z.ZodString;
    result: z.ZodUnion<readonly [z.ZodObject<{
        session_id: z.ZodString;
        run_id: z.ZodString;
        candidate_id: z.ZodString;
        reused: z.ZodBoolean;
    }, z.core.$strict>, z.ZodObject<{
        session_id: z.ZodString;
        run_id: z.ZodString;
        recorded: z.ZodNumber;
    }, z.core.$strict>]>;
}, z.core.$strict>;
export type ExecutionRunSidecarReceipt = z.infer<typeof executionRunSidecarReceiptSchema>;
export declare class SessionStoreLock {
    private readonly path;
    private readonly now;
    private readonly wait;
    private held;
    private token;
    constructor(path: string, timing?: Partial<SessionStoreLockTiming>);
    get isHeld(): boolean;
    acquire(): void;
    private waitForRetry;
    release(): void;
}
export type ExecutionSealReceiptInput = Omit<ExecutionSealReceiptV10, 'schema_version' | 'overall_hash'>;
export type ExecutionSealReceiptV11Input = Omit<ExecutionSealReceiptV11, 'schema_version' | 'overall_hash'>;
export declare function executionSealReceiptHash(receipt: ExecutionSealReceipt | ExecutionSealReceiptInput | ExecutionSealReceiptV11Input): string;
export declare function createExecutionSealReceipt(input: ExecutionSealReceiptInput): ExecutionSealReceiptV10;
export declare function createExecutionSealReceiptV11(input: ExecutionSealReceiptV11Input): ExecutionSealReceiptV11;
export declare function executionSealReceiptScopeSnapshots(runs: readonly CommandRunV14[], bundle: Pick<SessionBundle, 'gates' | 'artifacts' | 'evidence'>): Pick<ExecutionSealReceiptV11, 'gates' | 'artifacts' | 'evidence'>;
export type SessionArchiveReceiptInput = Omit<SessionArchiveReceipt, 'schema_version' | 'receipt_hash'>;
export declare function sessionArchiveReceiptHash(receipt: SessionArchiveReceipt | SessionArchiveReceiptInput): string;
export declare function createSessionArchiveReceipt(input: SessionArchiveReceiptInput): SessionArchiveReceipt;
export declare class SessionStore {
    readonly projectRoot: string;
    readonly workflowRoot: string;
    readonly sessionsRoot: string;
    private readonly lock;
    private readonly cache;
    constructor(projectRoot: string, options?: SessionStoreOptions);
    sessionDir(sessionId: string): string;
    executionDir(sessionId: string, executionId: string): string;
    executionPath(sessionId: string, executionId: string): string;
    executionTransitionPath(sessionId: string, executionId: string, requestId: string): string;
    executionRunSidecarReceiptPath(sessionId: string, executionId: string, requestId: string): string;
    executionSealReceiptPath(sessionId: string, executionId: string): string;
    sessionCompatibilityPath(sessionId: string): string;
    sessionArchiveReceiptPath(sessionId: string, activityRevision: number): string;
    sessionSchemaSelection(): SessionSchemaSelection;
    runDir(sessionId: string, runId: string): string;
    receiptsDir(sessionId: string): string;
    requestReceiptsDir(sessionId: string): string;
    transitionReceiptsDir(sessionId: string): string;
    requestReceiptV20Path(sessionId: string, requestId: string): string;
    transitionReceiptV20Path(sessionId: string, activityRevision: number, transitionId: string): string;
    withLock<T>(fn: () => T): T;
    sessionExists(sessionId: string): boolean;
    createSession(sessionId: string, intent: string, options?: {
        ifExists?: 'reuse' | 'error';
        command?: string;
        intentIdentity?: IntentIdentity;
        provenance?: SessionProvenance;
    }): SessionBundle;
    private assertRecoverableSessionShell;
    private ensureSessionProjections;
    readBundle(sessionId: string): SessionBundle;
    readSessionRecord(sessionId: string): SessionStateRead;
    /** Strict read of canonical session.json with no cross-version normalization. */
    readSessionRecordReadOnly(sessionId: string): SessionStateRead;
    readSessionV30(sessionId: string): SessionStateV30;
    writeSessionV30(sessionInput: SessionStateV30): SessionStateV30;
    /** Typed atomic storage batch for W2/W5. It deliberately performs no CAS or state-machine work. */
    withV30Transaction<T>(sessionId: string, builder: (tx: SessionV30StoreTransaction) => T): T;
    /**
     * Commit v3 knowledge sidecars and project corpus files without exposing
     * Session, Run, or immutable receipt writers to the callback.
     */
    withV30KnowledgeTransaction<T>(sessionId: string, builder: (tx: SessionV30KnowledgeStoreTransaction) => T): T;
    private readSessionRecordUnlocked;
    private readBundleUnlocked;
    readExecution(sessionId: string, executionId: string): ExecutionState;
    /** Validate an Execution without lock acquisition or recovery writes. */
    readExecutionReadOnly(sessionId: string, executionId: string): ExecutionState;
    private assertV3LegacyExecutionAuthorityRetiredUnlocked;
    private readExecutionUnlocked;
    readExecutionSealReceipt(sessionId: string, executionId: string): ExecutionSealReceipt | null;
    private readExecutionSealReceiptUnlocked;
    writeExecutionSealReceipt(receiptInput: ExecutionSealReceipt): ExecutionSealReceipt;
    private assertExecutionSealReceiptSnapshotUnlocked;
    private assertPersistedExecutionSealReceiptUnlocked;
    private assertExecutionSealReceiptV11CommitmentsUnlocked;
    private observedArtifactHashUnlocked;
    listExecutions(sessionId: string): ExecutionState[];
    private listExecutionsUnlocked;
    readOpenExecution(sessionId: string): ExecutionState | null;
    private readOpenExecutionUnlocked;
    createExecution(execution: ExecutionState): ExecutionState;
    updateExecution<T>(sessionId: string, executionId: string, expectedRevision: number | undefined, mutator: (draft: ExecutionState, tx: ExecutionStoreTransaction) => T): T;
    listExecutionTransitions(sessionId: string, executionId: string): PersistedTransitionRecordV11[];
    private listExecutionTransitionsUnlocked;
    readExecutionTransition(sessionId: string, executionId: string, requestId: string): PersistedTransitionRecordV11 | null;
    readExecutionTransitionReadOnly(sessionId: string, executionId: string, requestId: string): PersistedTransitionRecordV11 | null;
    private readExecutionTransitionUnlocked;
    readExecutionRun(sessionId: string, runId: string): CommandRunV14;
    private readExecutionRunUnlocked;
    listBoundExecutionRuns(sessionId: string, executionId: string, generation: number): CommandRunV14[];
    private listBoundExecutionRunsUnlocked;
    readRunRecord(sessionId: string, runId: string): RunRead;
    /** Validate a canonical Run document without normalization or recovery writes. */
    readRunRecordReadOnly(sessionId: string, runId: string): RunRead;
    private readRunRecordUnlocked;
    readRunV30(sessionId: string, runId: string): RunV30;
    writeRunV30(runInput: RunV30): RunV30;
    readRequestReceiptV20(sessionId: string, requestId: string): RequestReceiptV20 | null;
    private readRequestReceiptV20Unlocked;
    readTransitionReceiptV20(sessionId: string, activityRevision: number, transitionId: string): TransitionReceiptV20 | null;
    listTransitionReceiptsV20(sessionId: string): TransitionReceiptV20[];
    readRun(sessionId: string, runId: string): CommandRun;
    /** Validate a Run without lock acquisition, recovery, or filesystem writes. */
    readRunReadOnly(sessionId: string, runId: string): CommandRun;
    private readRunUnlocked;
    private findRetryReplacementUnlocked;
    createExecutionAtomic<T>(sessionId: string, builder: (draft: SessionBundle, existing: readonly ExecutionState[], tx: StoreTransaction) => {
        execution: ExecutionState | null;
        result: T;
    }, options?: Pick<ExecutionAtomicOptions, 'expectedActivityRevision'>): T;
    updateExecutionAtomic<T>(sessionId: string, executionId: string, expectedRevision: number | undefined, mutator: (draft: SessionBundle, execution: ExecutionState, tx: StoreTransaction) => T, options?: ExecutionAtomicOptions): T;
    update<T>(sessionId: string, mutator: (draft: SessionBundle, tx: StoreTransaction) => T, options?: {
        allowOpenExecution?: boolean;
    }): T;
    /**
     * Record post-Run knowledge lifecycle metadata without reopening immutable
     * Session execution state. Only the lifecycle object and sidecar transaction
     * are exposed to the caller.
     */
    updateKnowledgeLifecycle<T>(sessionId: string, mutator: (lifecycle: SessionState['lifecycle'], tx: StoreTransaction) => T): T;
    /**
     * Commit knowledge sidecars and corpus files under one SessionStore lock and
     * one recoverable transaction intent. The caller performs its final CAS
     * reads inside the callback before queueing writes.
     */
    updateKnowledgeTransaction<T>(sessionId: string, mutator: (tx: StoreTransaction) => T): T;
    private assertActiveRunSidecarMutationUnlocked;
    /**
     * Mutate one Run-owned sidecar only while that Run remains the canonical
     * active Run. This avoids rewriting the coordinated Session bundle for
     * high-frequency knowledge relation/candidate updates.
     */
    updateActiveRunSidecar<T, R>(sessionId: string, runId: string, path: string, schema: z.ZodType<T>, initial: T, mutator: (draft: T) => R): R;
    /**
     * Mutate one Run-owned sidecar under exact active Execution authority. The
     * sidecar and its idempotency receipt are committed in the same recoverable
     * store transaction; the private lease token is represented only by a hash.
     */
    updateActiveExecutionRunSidecar<T, R extends Record<string, unknown>>(input: {
        sessionId: string;
        runId: string;
        path: string;
        schema: z.ZodType<T>;
        initial: T;
        authority: ExecutionRunSidecarAuthority;
        operation: 'knowledge-stage' | 'knowledge-record';
        requestPayload: unknown;
        revisionOf: (value: T) => number;
        mutator: (draft: T) => R;
        now?: Date;
        staleAfterMs?: number;
    }): {
        result: R;
        replayed: boolean;
    };
    /** Replace one active Run sidecar atomically after validating Run authority. */
    writeActiveRunSidecar<T>(sessionId: string, runId: string, path: string, value: T, schema: z.ZodType<T>): void;
    private locateRunSessionId;
    /** Locate and strictly read a Run without normalizing across schema generations. */
    findRunRecord(runId: string, sessionId?: string): LocatedRunRecord;
    findRun(runId: string, sessionId?: string): {
        sessionId: string;
        run: CommandRun;
    };
    /** Enumerate canonical Session files only; state.json is never consulted. */
    listSessions(filters?: SessionListFilters): SessionListResult;
    /** Enumerate Sessions without lock acquisition, recovery, or projection writes. */
    listSessionsReadOnly(filters?: SessionListFilters): SessionListResult;
    private listSessionsUnlocked;
    /**
     * Resolve the unique active Run from canonical session.json files only.
     * This avoids parsing every coordinated Session bundle on each knowledge load.
     */
    findUniqueActiveRun(): {
        sessionId: string;
        runId: string;
    } | null;
    /**
     * Enumerate Sessions currently in `running` status with their active Run
     * (if any). Used by the knowledge write-authority resolver to implement the
     * narrowed single-session scan and fail-closed ambiguity reporting.
     */
    listRunningSessions(): Array<{
        sessionId: string;
        activeRunId: string | null;
    }>;
    issueRecallConfirmation(input: IssueRecallConfirmationInput): {
        token: string;
        record: RecallConfirmationRecord;
    };
    readRecallConfirmation(token: string): RecallConfirmationRecord | null;
    reserveRecallConfirmation(token: string, input: ReserveRecallConfirmationInput): SessionStoreReserveRecallResult;
    validateRecallConfirmationSource(action: RecallConfirmationRecord['action'], sourceFence: RecallConfirmationRecord['source_fence']): ValidatedRecallSource | null;
    claimRecallConfirmationTarget(reservationId: string, now?: Date): {
        reservation_id: string;
        marker: RecallReservationMarker;
        marker_path: string;
    };
    readRecallTargetHash(target: RecallConfirmationFinalTarget): string;
    finalizeRecallConfirmation(reservationId: string, input: FinalizeRecallConfirmationInput): {
        outcome: RecallConfirmationOutcome;
        replayed: boolean;
    };
    cancelRecallConfirmation(reservationId: string, now?: Date): {
        reservation_id: string;
        rollback_target: RecallConfirmationTargetIdentity;
        released: boolean;
    };
    observeRecallConfirmationReservation(reservationId: string, observedAt?: Date): RecallReservationObservation;
    reconcileExpiredRecallConfirmation(reservationId: string, reportedInput: RecallReservationObservation, now?: Date): RecallReservationReconciliation;
    completeRecallConfirmationRollback(reservationId: string, reportedInput: RecallReservationObservation): {
        reservation_id: string;
        rollback_target: RecallConfirmationTargetIdentity;
        released: true;
    };
    consumeRecallConfirmation(token: string, expected: {
        action: RecallConfirmationRecord['action'];
        request_hash: string;
        now?: Date;
    }, result: {
        session_id: string;
        run_id?: string | null;
    }): RecallConfirmationRecord;
    readSessionFence(sessionId: string, runId?: string | null): TransitionFence;
    validateSourceTargetFences(input: {
        source: {
            session_id: string;
            run_id?: string | null;
            fence: TransitionFence;
        };
        target?: {
            session_id: string;
            run_id?: string | null;
            fence: TransitionFence;
        };
    }): {
        source: TransitionFence;
        target: TransitionFence | null;
    };
    replayOrApplyArtifactRepublishTransition(sessionId: string, request: TransitionRequest, apply: (draft: SessionBundle, tx: StoreTransaction) => TransitionOutcome): {
        outcome: TransitionOutcome;
        replayed: boolean;
    };
    replayOrApplyTransition(sessionId: string, request: TransitionRequest, apply: (draft: SessionBundle, tx: StoreTransaction) => TransitionOutcome, validateReplay?: (record: PersistedTransitionRecord) => void, options?: {
        allowOpenExecution?: boolean;
    }): {
        outcome: TransitionOutcome;
        replayed: boolean;
    };
    listSessionArchiveReceipts(sessionId: string): SessionArchiveReceipt[];
    private listSessionArchiveReceiptsUnlocked;
    applySessionArchiveReceipt(receiptInput: SessionArchiveReceipt): SessionIdentityV20;
    migrateLegacySessionToV20(input: {
        identity: SessionIdentityV20;
        compatibility: SessionState;
        legacyExecution?: ExecutionState;
        archiveReceipt?: SessionArchiveReceipt;
        sourceIdentityRevision: number;
        sourceActivityRevision: number;
    }): void;
    private createHistoricalExecutionSealReceiptUnlocked;
    private assertSessionV30MutationUnsupported;
    assertLegacySessionMutationAllowed(sessionId: string): void;
    clearCache(): void;
    readJsonFile<T>(path: string, schema: z.ZodType<T>, fallback?: T): T;
    /** Read and validate a sidecar without lock acquisition or recovery writes. */
    readJsonFileReadOnly<T>(path: string, schema: z.ZodType<T>, fallback?: T): T;
    private readJsonFileUnlocked;
    updateJsonFile<T>(path: string, schema: z.ZodType<T>, initial: T, mutator: (draft: T) => void): T;
    appendLine(path: string, line: string): void;
    private recallRegistryPath;
    private readRecallRegistryUnlocked;
    private findRecallReservationUnlocked;
    private recallReservationMarkerPath;
    private assertRecallReservationMarkerUnlocked;
    private observeRecallReservationUnlocked;
    private hashRecallTargetDirectoryUnlocked;
    private validateRecallSourceFenceUnlocked;
    private validateSourceFenceAtRootUnlocked;
    private validateReceiptSourceFenceAtRootUnlocked;
    private assertRecallTargetFenceUnlocked;
    private recallTargetHashUnlocked;
    private recallTargetAuthorityHashUnlocked;
    private sessionFenceUnlocked;
    private sessionFenceForBundle;
    private transactionIntentPath;
    private reconcileTransactionIntentUnlocked;
    private assertWorkflowPath;
    private assertSafeWriteTarget;
    private readValidated;
    private writeFreshBundleUnlocked;
    private prepareExecutionCompatibilityDraft;
    private assertExpectedActivityRevision;
    private addExecutionAtomicBundleWrites;
    private assertPendingExecutionSealReceiptUnlocked;
    private writeBatchUnlocked;
    private backup;
}
export declare class SessionV30KnowledgeStoreTransaction {
    private readonly store;
    private readonly sessionId;
    private readonly writes;
    private lockedCorpusPaths;
    private releaseLockedCorpus;
    constructor(store: SessionStore, sessionId: string);
    pendingWrites(): JsonWrite[];
    lockCorpusNamespace(): void;
    lockCorpusPaths(paths: readonly string[]): void;
    releaseCorpusLocks(): void;
    readSession(): SessionStateV30;
    readRun(runId: string): RunV30;
    readRunRecord(runId: string): RunRead;
    readJson<T>(path: string, schema: z.ZodType<T>, fallback?: T): T;
    writeJson<T>(path: string, value: T, schema: z.ZodType<T>, mode?: number): void;
    writeTranscriptEvidenceSnapshot<T>(path: string, value: T, schema: z.ZodType<T>, mode?: number): void;
    readText(path: string): string | null;
    writeText(path: string, content: string, mode?: number): void;
    pendingText(path: string): string | null;
}
export declare class SessionV30StoreTransaction {
    private readonly store;
    private readonly sessionId;
    private readonly writes;
    constructor(store: SessionStore, sessionId: string);
    pendingWrites(): JsonWrite[];
    private assertNotReceiptPath;
    sessionExists(): boolean;
    runExists(runId: string): boolean;
    readSession(): SessionStateV30;
    readRun(runId: string): RunV30;
    readArtifactRepublishReceipt(receiptId: string): ArtifactRepublishReceipt | null;
    readRequestReceipt(requestId: string): RequestReceiptV20 | null;
    readTransitionReceipt(activityRevision: number, transitionId: string): TransitionReceiptV20 | null;
    listTransitionReceipts(): TransitionReceiptV20[];
    readJson<T>(path: string, schema: z.ZodType<T>): T;
    writeSession(sessionInput: SessionStateV30): void;
    writeRun(runInput: RunV30): void;
    writeRequestReceipt(receiptInput: RequestReceiptV20): void;
    writeTransitionReceipt(receiptInput: TransitionReceiptV20): void;
    writeArtifactRepublishReceipt(receiptInput: ArtifactRepublishReceipt): void;
    writeJson(path: string, value: unknown, schema: z.ZodType, mode?: number): void;
    writeRaw(path: string, raw: string, mode?: number): void;
}
export declare class ExecutionStoreTransaction {
    private readonly store;
    private readonly sessionId;
    private readonly executionId;
    readonly writes: JsonWrite[];
    constructor(store: SessionStore, sessionId: string, executionId: string);
    writeExecution(execution: ExecutionState): void;
    writeTransition(record: PersistedTransitionRecordV11, schema: z.ZodType<PersistedTransitionRecordV11>): void;
    writeSealReceipt(receipt: ExecutionSealReceipt): void;
    writeJson(path: string, value: unknown, schema?: z.ZodType): void;
}
export declare class StoreTransaction {
    private readonly store;
    private readonly sessionId;
    readonly writes: JsonWrite[];
    constructor(store: SessionStore, sessionId: string);
    readExecution(executionId: string): ExecutionState;
    readRun(runId: string): CommandRun;
    readExecutionRun(runId: string): CommandRunV14;
    readJson<T>(path: string, schema: z.ZodType<T>, fallback?: T): T;
    listExecutionTransitions(executionId: string): PersistedTransitionRecordV11[];
    readExecutionTransition(executionId: string, requestId: string): PersistedTransitionRecordV11 | null;
    listBoundExecutionRuns(executionId: string, generation: number): CommandRunV14[];
    gates(): GateRegistry;
    writeRun(run: CommandRun | CommandRunV14): void;
    writeExecution(execution: ExecutionState): void;
    writeExecutionTransition(executionId: string, record: PersistedTransitionRecordV11): void;
    writeExecutionSealReceipt(executionId: string, receipt: ExecutionSealReceipt): void;
    writeJson(path: string, value: unknown, schema?: z.ZodType, mode?: number): void;
    writeText(path: string, content: string, mode?: number): void;
    pendingText(path: string): string | null;
    pendingExecutionSealReceipt(executionId: string): ExecutionSealReceipt | null;
    addStatuslessBundle(bundle: SessionBundle, identity: SessionIdentityV20): void;
    addBundle(bundle: SessionBundle): void;
}
export {};
