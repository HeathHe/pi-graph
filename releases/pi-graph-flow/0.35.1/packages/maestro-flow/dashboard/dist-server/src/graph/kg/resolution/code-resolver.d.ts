import type { DatabaseSync } from 'node:sqlite';
import type { UnifiedEdge } from '../db/types.js';
export interface CodeResolutionOptions {
    projectPath?: string;
    /** The caller already owns the surrounding SQLite transaction. */
    transactionMode?: 'managed' | 'caller-owned';
}
export interface CodeResolutionResult {
    edgesCreated: number;
    importsEdges: number;
    callsEdges: number;
    /** 未能解析为边的引用数 (外部包 / 无匹配符号) */
    unresolvedCount: number;
    durationMs: number;
    edges: UnifiedEdge[];
}
export declare function resolveCodeReferences(db: DatabaseSync, options?: CodeResolutionOptions): CodeResolutionResult;
