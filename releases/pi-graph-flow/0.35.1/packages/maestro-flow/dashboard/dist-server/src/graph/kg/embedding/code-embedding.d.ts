import type { UnifiedNode, UnifiedNodeKind } from '../db/types.js';
export interface CodeEmbeddingIndex {
    modelId: string;
    dimension: number;
    nodeIds: string[];
    vectors: Float32Array[];
    contentHashes?: string[];
    builtAt: number;
    buildTimeMs?: number;
    normalized?: boolean;
    flatMatrixBuffer?: Float32Array;
}
export interface VectorSearchResult {
    nodeId: string;
    score: number;
}
export declare const EMBEDDABLE_KINDS: ReadonlySet<UnifiedNodeKind>;
/**
 * Convert a UnifiedNode into structured text suitable for embedding.
 * Fields are separated by newlines with labeled prefixes for better retrieval.
 * Adds 'passage: ' prefix when using local model (non-API mode).
 */
export declare function nodeToEmbeddingText(node: UnifiedNode, apiMode?: boolean): string;
/**
 * Returns true if the node kind is worth embedding and it originates from codegraph.
 */
export declare function isEmbeddable(node: UnifiedNode): boolean;
/**
 * Build a code embedding index from UnifiedNode[].
 * Supports incremental rebuild: if `existing` is provided, only re-embeds
 * nodes whose content hash has changed.
 */
export declare function buildCodeEmbeddingIndex(nodes: UnifiedNode[], existing?: CodeEmbeddingIndex | null): Promise<CodeEmbeddingIndex>;
/**
 * Vector search over the code embedding index.
 * Uses dot product on pre-normalized vectors when available, falls back to cosine.
 */
export declare function searchCodeVectors(queryVec: Float32Array, index: CodeEmbeddingIndex, limit: number): VectorSearchResult[];
/**
 * Save a CodeEmbeddingIndex to disk in binary format.
 */
export declare function saveCodeEmbeddingIndex(index: CodeEmbeddingIndex, dir: string): void;
/**
 * Load a CodeEmbeddingIndex from disk. Returns null if file doesn't exist.
 */
export declare function loadCodeEmbeddingIndex(dir: string): CodeEmbeddingIndex | null;
