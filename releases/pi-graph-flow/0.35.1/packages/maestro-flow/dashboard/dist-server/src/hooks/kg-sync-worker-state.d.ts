export declare const KG_SYNC_WORKER_MARKER_SCHEMA_VERSION: "kg-sync-worker-marker/1.0";
export declare const KG_SYNC_WORKER_MARKER_RELATIVE_PATH: ".workflow/kg-sync-worker.pid";
export declare const DEFAULT_KG_SYNC_WORKER_STALE_MS: number;
export declare const KG_SYNC_WORKER_MARKER_MAX_BYTES: number;
export type KgSyncWorkerMode = 'worker' | 'maintenance';
export interface KgSyncWorkerMarker {
    schema_version: typeof KG_SYNC_WORKER_MARKER_SCHEMA_VERSION;
    pid: number;
    token: string;
    started_at: number;
    mode: KgSyncWorkerMode;
    legacy: false;
}
export interface LegacyKgSyncWorkerMarker {
    pid: number;
    token: null;
    started_at: null;
    mode: 'worker';
    legacy: true;
}
export type ParsedKgSyncWorkerMarker = KgSyncWorkerMarker | LegacyKgSyncWorkerMarker;
export type KgSyncWorkerMarkerInvalidReason = 'unsafe-parent' | 'symlink' | 'not-regular' | 'too-large' | 'changed' | 'read-failed' | 'malformed' | 'future-timestamp' | 'future-mtime';
export interface KgSyncWorkerFileGeneration {
    device: number;
    inode: number;
}
export interface KgSyncWorkerToken {
    projectRoot: string;
    path: string;
    pid: number;
    token: string;
    startedAt: number;
    mode: KgSyncWorkerMode;
    inode: number;
    /** Additive generation fence used by hardened releases. */
    generation?: KgSyncWorkerFileGeneration;
    /** Lease duration used by the local heartbeat. */
    leaseMs?: number;
}
export interface KgSyncWorkerInspection {
    exists: boolean;
    live: boolean;
    owner: ParsedKgSyncWorkerMarker | null;
    /** A live PID from line one of a malformed versioned record. */
    foreignPid: number | null;
    ageMs: number;
    path: string;
    invalidReason?: KgSyncWorkerMarkerInvalidReason | null;
}
export interface AcquireKgSyncWorkerOptions {
    pid?: number;
    token?: string;
    now?: number;
    staleMs?: number;
    isPidLive?: (pid: number) => boolean;
}
export type AcquireKgSyncWorkerResult = {
    acquired: true;
    token: KgSyncWorkerToken;
} | {
    acquired: false;
    reason: 'already-running';
    ownerMode: KgSyncWorkerMode | 'foreign';
    ownerPid: number | null;
    legacy: boolean;
};
export declare class UnsafeKgSyncWorkerMarkerError extends Error {
    readonly code: "KG_SYNC_WORKER_UNSAFE_PATH";
    readonly path: string;
    constructor(path: string, detail: string);
}
export declare class KgSyncWorkerMutationBusyError extends Error {
    readonly code: "KG_SYNC_WORKER_MUTATION_BUSY";
    readonly path: string;
    constructor(path: string);
}
export declare function kgSyncWorkerMarkerPath(projectRoot: string): string;
/**
 * PID remains line one so the installed 0.5.63 `parseInt(...trim(), 10)` reader
 * sees a versioned marker as its original live-worker wire format.
 */
export declare function serializeKgSyncWorkerMarker(pid: number, token: string, startedAt: number, mode: KgSyncWorkerMode): string;
/** Accepts only legacy decimal bytes or the exact versioned two-line record. */
export declare function parseKgSyncWorkerMarker(raw: string): ParsedKgSyncWorkerMarker | null;
export declare function inspectKgSyncWorkerMarker(projectRoot: string, options?: Pick<AcquireKgSyncWorkerOptions, 'now' | 'isPidLive'>): KgSyncWorkerInspection;
/** Exclusive marker creation is serialized with reclaim and release. */
export declare function acquireKgSyncWorkerToken(projectRoot: string, mode: KgSyncWorkerMode, options?: AcquireKgSyncWorkerOptions): AcquireKgSyncWorkerResult;
/** Refreshes the finite lease without changing the marker generation. */
export declare function refreshKgSyncWorkerToken(token: KgSyncWorkerToken, now?: number): boolean;
/** Removes only the same versioned token and filesystem generation acquired. */
export declare function releaseKgSyncWorkerToken(token: KgSyncWorkerToken): boolean;
/** Reconstructs ownership in the detached worker after its parent wrote bytes. */
export declare function adoptKgSyncWorkerToken(projectRoot: string, pid: number, token: string): KgSyncWorkerToken | null;
export declare function waitForKgSyncWorkerQuiescence(projectRoot: string, timeoutMs: number): Promise<void>;
export declare function withKgSyncMaintenanceToken<T>(projectRoot: string, fn: () => Promise<T> | T): Promise<T>;
