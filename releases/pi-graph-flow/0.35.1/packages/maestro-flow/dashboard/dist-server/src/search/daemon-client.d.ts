/**
 * Search daemon client — lightweight module for connecting to the resident
 * search daemon. No WikiIndexer or heavy dependencies.
 */
export type { DaemonInfo, DaemonInfoV2, DaemonSearchRequest, DaemonSearchResponse, DaemonState, } from './daemon-types.js';
export { canonicalWorkflowRoot, getDaemonPath, isDaemonAlive, isDaemonInfoV2, isDaemonReadyResponse, readDaemonInfo, } from './daemon-types.js';
import { SEARCH_DAEMON_PROTOCOL } from './daemon-types.js';
import type { DaemonSearchRequest, DaemonSearchResponse } from './daemon-types.js';
import type { SearchDiagnosticsRecorder } from './diagnostics.js';
import type { SearchCandidateBudget } from './candidate-budget.js';
export type { SearchDiagnostics, SearchDiagnosticsContext, SearchDiagnosticsRecorder } from './diagnostics.js';
export type { SearchCandidateBudget } from './candidate-budget.js';
export type DaemonFailureReason = 'timeout' | 'connect-error' | 'bad-response' | 'response-too-large' | 'identity-mismatch';
export interface DaemonQueryOptions {
    timeoutMs?: number;
    filters?: DaemonSearchRequest['filters'];
    /** Opt-in request-scoped diagnostics; absent keeps the wire response unchanged. */
    diagnostics?: boolean | SearchDiagnosticsRecorder;
    /** Optional caller-owned ID propagated to the daemon diagnostics recorder. */
    diagnosticsRequestId?: string;
    /** Effective repository/link authority expected by this caller. */
    authorityKey?: string;
    /** One boundary-computed candidate budget forwarded unchanged to the daemon. */
    candidateBudget?: SearchCandidateBudget;
    /** Optional bounded load selection; rejected by older daemons and retried as legacy load. */
    selection?: DaemonSearchRequest['selection'];
    /** Tests and memory-sensitive callers may lower, but never raise, the hard cap. */
    maxResponseBytes?: number;
    /** Internal attribution hook; receives bounded reason codes only. */
    onFailure?: (reason: DaemonFailureReason) => void;
}
export declare function queryDaemon(port: number, req: DaemonSearchRequest, opts?: DaemonQueryOptions): Promise<DaemonSearchResponse>;
export declare function pingDaemon(workflowRoot: string, opts?: DaemonQueryOptions): Promise<DaemonSearchResponse | null>;
export declare function healthDaemon(workflowRoot: string, opts?: DaemonQueryOptions): Promise<DaemonSearchResponse | null>;
export declare function tryDaemonSearch(workflowRoot: string, query: string, limit: number, skipEmbedding?: boolean, opts?: DaemonQueryOptions): Promise<DaemonSearchResponse | null>;
/** Retrieve a bounded warm-index selection, with a legacy full-load retry for older daemons. */
export declare function tryDaemonLoad(workflowRoot: string, opts?: DaemonQueryOptions): Promise<DaemonSearchResponse | null>;
/**
 * Ask the exact v2 instance in the descriptor to shut down. This function never
 * sends a process signal and never removes an unverified/legacy descriptor.
 */
export declare function stopDaemon(workflowRoot: string): Promise<boolean>;
/**
 * Claim the right to spawn a daemon, or return null if someone else holds it.
 * A short-lived reclaim lock serializes stale-primary removal so a contender
 * can never unlink a fresh successor lock between its read and unlink.
 */
export declare function claimSpawnLock(workflowRoot: string): string | null;
/**
 * Drop a dead-pid descriptor while holding the spawn lock so unlink cannot
 * delete a successor published by another startup.
 * claimSpawnLock may return a fallback token without owning the lock file;
 * that path must not unlink.
 */
export declare function reclaimDeadDaemonDescriptor(workflowRoot: string): boolean;
export declare function spawnDaemon(workflowRoot: string): Promise<void>;
/**
 * Invalidate the search index: signal a verified daemon to rebuild if alive,
 * otherwise delete its persisted caches so the next search rebuilds. An
 * explicit `{ ok: false }` is a failed invalidate, not an acknowledgement.
 */
export declare function invalidateSearchIndex(workflowRoot: string, opts?: DaemonQueryOptions): Promise<void>;
export { SEARCH_DAEMON_PROTOCOL };
