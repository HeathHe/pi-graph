/**
 * Search daemon — resident process that keeps WikiIndexer + ONNX model warm.
 *
 * Protocol: one line-delimited JSON request per TCP connection on localhost.
 * Descriptor: .workflow/search-daemon.json (authenticated protocol v2 identity).
 * Idle timeout: gracefully drain after a configurable period of work inactivity.
 */
import { type Server } from 'node:net';
import { type WikiIndexerConfig } from '#maestro-dashboard/wiki/wiki-indexer.js';
export type { DaemonInfo, DaemonInfoV2, DaemonSearchRequest, DaemonSearchResponse, DaemonState, } from './daemon-types.js';
export { getDaemonPath, isDaemonAlive, isDaemonInfoV2, readDaemonInfo, } from './daemon-types.js';
export interface SearchDaemonRuntimeOptions {
    socketTimeoutMs?: number;
    drainTimeoutMs?: number;
    maxConnections?: number;
    maxActiveRequests?: number;
    /** 0 disables idle shutdown; otherwise the daemon drains after this work-idle period. */
    idleTimeoutMs?: number;
    /** Dedicated daemon commands may hard-exit after cleanup exceeds its deadline. */
    exitOnDrainTimeout?: boolean;
}
export declare function startDaemon(workflowRoot: string, config: WikiIndexerConfig, runtime?: SearchDaemonRuntimeOptions): Promise<{
    port: number;
    server: Server;
}>;
//# sourceMappingURL=daemon.d.ts.map