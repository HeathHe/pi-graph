/**
 * KG Sync State — persistent freshness watermark for codegraph sync.
 *
 * Records the git HEAD at the last successful codegraph sync in
 * .workflow/kg/sync-state.json so change detection can catch committed
 * changes (commit / pull / branch switch) that leave the working tree clean.
 */
export declare const KG_SYNC_STATE_SCHEMA_VERSION: "kg-sync-state/2.0";
export interface KgSyncWatermark {
    head: string | null;
    manifestDigest: string | null;
    externalFingerprint: string;
    startedAt: number;
    completedAt: number;
}
export interface KgSyncAttempt {
    status: 'succeeded' | 'failed';
    startedAt: number;
    finishedAt: number;
    error: string | null;
}
export interface KgSyncState {
    schema_version: typeof KG_SYNC_STATE_SCHEMA_VERSION;
    lastSuccessful: KgSyncWatermark | null;
    lastAttempt: KgSyncAttempt | null;
    /** Runtime-only compatibility view consumed by the existing hook. */
    lastSyncHead: string | null;
    lastSyncAt: number;
    /** Legacy state must never be considered fresh without one v2 sync. */
    requiresRefresh: boolean;
}
export interface KgSyncStateHealth {
    status: 'missing' | 'fresh' | 'stale' | 'error';
    stale: boolean;
    error: string | null;
    state: KgSyncState | null;
}
export interface WriteSyncStateOptions {
    startedAt?: number;
    /** Deterministic post-COMMIT fault injection used by transaction tests. */
    beforeSuccessWrite?: () => void;
}
export interface KgSyncFreshnessSnapshot {
    head: string | null;
    manifestDigest: string | null;
    externalFingerprint: string;
}
export declare function getSyncStatePath(projectPath: string): string;
export declare function readSyncState(projectPath: string): KgSyncState | null;
export declare function writeSyncState(projectPath: string, head: string | null, manifestDigest?: string | null, externalFingerprint?: string, options?: WriteSyncStateOptions): void;
/** Records a failed attempt without advancing the last successful watermark. */
export declare function writeSyncStateFailure(projectPath: string, startedAt: number, error: unknown): void;
export declare function getSyncStateHealth(projectPath: string): KgSyncStateHealth;
/** A v2 watermark is fresh only when every authoritative input still matches. */
export declare function isSyncStateFresh(state: KgSyncState | null, snapshot: KgSyncFreshnessSnapshot): boolean;
export declare function getGitHead(projectPath: string): string | null;
