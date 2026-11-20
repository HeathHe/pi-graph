import type { MaestroGraph } from '../engine.js';
import type { SyncResult, SourceType } from '../db/types.js';
export interface CodegraphSyncOptions {
    srcDirs?: string[];
    includeTests?: boolean;
    maxFileSize?: number;
    excludeDirs?: string[];
    excludeFiles?: string[];
    createMaestroIgnore?: boolean;
    allowExtractorScripts?: boolean;
    onProgress?: (file: string, count: number, total: number) => void;
}
export interface SyncKnowledgeGraphOptions {
    full?: boolean;
    sources?: SourceType[];
    codegraph?: CodegraphSyncOptions;
    /** Existing graph connection. The caller retains lifecycle ownership. */
    graph?: MaestroGraph;
    /** Deterministic failure points for atomicity regression tests. */
    faultInjection?: {
        beforeSourceScan?: (srcDir: string, index: number) => void;
        beforeStructuralResolution?: () => void;
        beforeFtsRebuild?: () => void;
        beforeTransactionCommit?: () => void;
        beforeSyncStateCommit?: () => void;
    };
}
export declare class CodegraphSyncCommittedError extends Error {
    readonly graphCommitted = true;
    readonly retryable = true;
    constructor(cause: unknown);
}
export declare function syncKnowledgeGraph(projectPath: string, options?: SyncKnowledgeGraphOptions): Promise<SyncResult[]>;
