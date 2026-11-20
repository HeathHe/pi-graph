/**
 * Shared types and utilities for the search daemon (client + server).
 * Single source of truth — both daemon.ts and daemon-client.ts import from here.
 */
import type { WikiEntry, WikiSearchFilters } from '#maestro-dashboard/wiki/wiki-types.js';
import type { SearchDiagnostics } from './diagnostics.js';
import type { SearchCandidateBudget } from './candidate-budget.js';
import { type DaemonLoadSelection } from './load-selection.js';
export declare const DAEMON_SPAWN_LOCK_FILE = "search-daemon-spawning";
/** Protocol v2 is authenticated with the per-process descriptor instanceId. */
export declare const SEARCH_DAEMON_PROTOCOL: "maestro-search-daemon/v2";
export declare const DAEMON_MAX_QUERY_CHARS = 4096;
export declare const DAEMON_MAX_RESULTS = 500;
export declare const DAEMON_MAX_REQUEST_BYTES: number;
export declare const DAEMON_MAX_RESPONSE_BYTES: number;
export type DaemonState = 'starting' | 'ready' | 'draining' | 'stopped';
/**
 * Descriptor written by daemon implementations before protocol v2.
 *
 * It remains readable so status output can explain it, but it is never trusted
 * for search or shutdown: a PID alone is not proof that the process occupying it
 * is the daemon that wrote this file.
 */
export interface LegacyDaemonInfo {
    pid: number;
    port: number;
    startedAt: string;
}
export interface DaemonInfoV2 extends LegacyDaemonInfo {
    protocol: typeof SEARCH_DAEMON_PROTOCOL;
    instanceId: string;
    /** Canonical absolute workflow root; this fences descriptors by workspace. */
    workflowRoot: string;
    /** Effective repository/link authority captured when this daemon started. */
    authorityKey?: string;
}
export type DaemonInfo = LegacyDaemonInfo | DaemonInfoV2;
export interface DaemonSearchRequest {
    action: 'search' | 'load' | 'invalidate' | 'ping' | 'health' | 'shutdown';
    query?: string;
    limit?: number;
    skipEmbedding?: boolean;
    filters?: WikiSearchFilters;
    /** One boundary-computed budget; omitted keeps the legacy provider path. */
    candidateBudget?: SearchCandidateBudget;
    /** Opt-in only; diagnostics are request-scoped and never persisted. */
    diagnostics?: boolean | {
        requestId?: string;
    };
    /** Optional bounded server-side selection for load; absent preserves full-index behavior. */
    selection?: DaemonLoadSelection;
    protocol?: typeof SEARCH_DAEMON_PROTOCOL;
    instanceId?: string;
    workflowRoot?: string;
}
export interface DaemonSearchResponse {
    ok: boolean;
    results?: Array<{
        entry: WikiEntry;
        score: number;
    }>;
    /** Full warm index for legacy load, or bounded selected entries for modern load. */
    entries?: WikiEntry[];
    generatedAt?: number;
    /** True only when the daemon applied the optional load selection. */
    selectionApplied?: boolean;
    embeddingUsed?: boolean;
    embeddingDocs?: number;
    /** True only when the daemon applied request filters before ranking truncation. */
    filtersApplied?: boolean;
    /** Optional request-scoped diagnostics; older daemons omit this field. */
    diagnostics?: SearchDiagnostics;
    error?: string;
    protocol?: typeof SEARCH_DAEMON_PROTOCOL;
    instanceId?: string;
    workflowRoot?: string;
    state?: DaemonState;
    pid?: number;
    startedAt?: string;
    activeRequests?: number;
    activeConnections?: number;
    idleTimeoutMs?: number;
    idleDeadline?: string | null;
    authorityKey?: string;
}
/** Starting/draining health is observable but is never startup readiness. */
export declare function isDaemonReadyResponse(response: DaemonSearchResponse | null | undefined): response is DaemonSearchResponse & {
    ok: true;
    state: 'ready';
};
export type DaemonRequestValidation = {
    ok: true;
    request: DaemonSearchRequest;
} | {
    ok: false;
    error: string;
};
/** Resolve symlinks when possible and make Windows path comparisons stable. */
export declare function canonicalWorkflowRoot(workflowRoot: string): string;
export declare function isDaemonInfoV2(info: DaemonInfo | unknown, workflowRoot?: string): info is DaemonInfoV2;
export declare function getDaemonPath(workflowRoot: string): string;
export declare function getDaemonSpawnLockPath(workflowRoot: string): string;
/**
 * Parse and validate both descriptor generations. Partially-v2 or malformed v2
 * data is rejected rather than silently downgraded to an unverified descriptor.
 */
export declare function readDaemonInfo(workflowRoot: string): DaemonInfo | null;
/** PID existence is only a stale-file hint. It is never daemon authentication. */
export declare function isDaemonAlive(info: DaemonInfo): boolean;
export declare function daemonIdentityRequest(info: DaemonInfoV2): Pick<DaemonSearchRequest, 'protocol' | 'instanceId' | 'workflowRoot'>;
export declare function isResponseFromDaemon(info: DaemonInfoV2, response: DaemonSearchResponse): boolean;
/** Remove a v2 descriptor only when the same instance still owns the path. */
export declare function deleteDaemonInfoIfOwned(workflowRoot: string, owner: Pick<DaemonInfoV2, 'instanceId' | 'workflowRoot'>): boolean;
/**
 * Reclaim a descriptor only after its recorded PID is dead and the descriptor
 * still matches the inspected value. This is used during startup, never stop.
 */
export declare function deleteDaemonInfoIfStale(workflowRoot: string, expected: DaemonInfo): boolean;
/**
 * Drop a dead-pid descriptor for this workflow so a successor can spawn.
 * Live, foreign, and malformed descriptors are left in place.
 * Legacy files in this directory are reclaimed when their PID is dead;
 * the path itself is the workspace identity for that generation.
 */
export declare function reclaimDeadDaemonDescriptor(workflowRoot: string): boolean;
/** Release a spawn lock only when the caller still owns its opaque token. */
export declare function releaseDaemonSpawnLock(workflowRoot: string, token: string | undefined): boolean;
/**
 * Once a v2 descriptor is atomically owned, it safely supersedes every spawn
 * arbitration artifact: all other contenders must observe the live descriptor
 * before spawning or fail their own descriptor `wx` claim.
 */
export declare function deleteDaemonSpawnLocksIfOwned(workflowRoot: string, owner: Pick<DaemonInfoV2, 'instanceId' | 'workflowRoot'>): boolean;
/** Strict protocol boundary validation before any indexer work is started. */
export declare function validateDaemonRequest(value: unknown): DaemonRequestValidation;
