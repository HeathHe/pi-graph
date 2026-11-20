import type { GraphNode, GraphEdge, BatchData, MergeResult } from './types.js';
/**
 * Canonicalize an edge `direction` value to one of the schema enum members.
 */
export declare function normalizeDirection(value: unknown): string;
/**
 * Normalize a node ID, returning the corrected version.
 */
export declare function normalizeNodeId(nodeId: string, node: Partial<GraphNode>): string;
/**
 * Normalize a complexity value.
 * Returns [normalized, status] where status is "valid" | "mapped" | "unknown".
 */
export declare function normalizeComplexity(value: unknown): [string, string];
/**
 * Return true if `path` looks like a test file by basename convention.
 */
export declare function isTestPath(p: string): boolean;
/**
 * For a test file path, return ordered candidate production paths.
 */
export declare function productionCandidates(testPath: string): string[];
interface LinkTestsResult {
    added: number;
    dropped: number;
    tagged: number;
    swapped: number;
}
/**
 * Canonicalize tested_by edges and link unmatched test files.
 *
 * Two-pass linker:
 *   Pass 1: Fix LLM-emitted tested_by edges (flip if source is test + target is production)
 *   Pass 2: Supplement with path-convention pairings
 *
 * Mutates nodesById (adds "tested" tag) and edges (rewrites in place).
 */
export declare function linkTests(nodesById: Map<string, GraphNode>, edges: GraphEdge[]): LinkTestsResult;
/**
 * Merge batch results and normalize.
 */
export declare function mergeGraphs(batches: BatchData[]): MergeResult;
interface ImportRecoveryResult {
    recovered: number;
    reportLines: string[];
}
/**
 * Re-emit any `imports` edges that exist in scan-result.json#importMap
 * but never made it into a batch's output.
 */
export declare function recoverImportsFromScan(assembled: {
    nodes: GraphNode[];
    edges: GraphEdge[];
}, scanResultPath: string): ImportRecoveryResult;
export {};
//# sourceMappingURL=merger.d.ts.map