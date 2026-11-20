import type { EmbeddingIndex } from './embedding.js';
import { type InvertedIndex } from './search.js';
import type { WikiEntry, WikiIndex } from './wiki-types.js';
import { type SourceChange, type SourceManifest, type SourceManifestEntry } from './source-manifest.js';
/** A half-open vector-slot range belonging to one document. */
export interface EmbeddingRange {
    docId: string;
    start: number;
    end: number;
}
export interface IncrementalEmbeddingUpdate {
    /** Existing vectors retained for unchanged documents; missing docs are rebuilt later. */
    index: EmbeddingIndex | null;
    ranges: Map<string, EmbeddingRange>;
    retainedDocIds: string[];
    invalidatedDocIds: string[];
}
export interface IncrementalIndexState {
    index: WikiIndex;
    /** BM25 state corresponding exactly to `index.entries`. */
    searchIndex: InvertedIndex | null;
    /** Optional embedding seed/ranges from the previous generation. */
    embedding?: EmbeddingIndex | null;
    embeddingRanges?: Map<string, EmbeddingRange>;
    manifest: SourceManifest;
    generation: number;
}
export interface IncrementalIndexUpdateOptions {
    previous: IncrementalIndexState;
    currentManifest: SourceManifest;
    changes?: readonly SourceChange[];
    /** Parse one changed covered source. Never mutate `previous` entries. */
    loadSource: (source: SourceManifestEntry, change: SourceChange, signal?: AbortSignal) => Promise<readonly WikiEntry[]>;
    /**
     * Optional kind-wide reload hook for projections whose output is globally
     * deduplicated (issues are currently the only such source).
     */
    loadSourcesForKind?: (sourceKind: SourceManifestEntry['sourceKind'], sources: readonly SourceManifestEntry[], signal?: AbortSignal) => Promise<readonly WikiEntry[]>;
    /** Optional generation timestamp; defaults to a fresh millisecond timestamp. */
    generation?: number;
    signal?: AbortSignal;
}
export interface IncrementalIndexUpdated {
    status: 'updated';
    state: IncrementalIndexState;
    changes: SourceChange[];
    changedEntryIds: string[];
    embedding: IncrementalEmbeddingUpdate;
}
export interface IncrementalIndexFallback {
    status: 'fallback';
    reason: string;
    changes: SourceChange[];
}
export type IncrementalIndexResult = IncrementalIndexUpdated | IncrementalIndexFallback;
/**
 * Build maps, collision IDs, backlinks, and deterministic ordering from a
 * detached entry list. This is intentionally shared by full and incremental
 * callers so an incremental publication has exactly the same derived shape.
 */
export declare function buildDeterministicWikiIndex(input: readonly WikiEntry[], generatedAt?: number, signal?: AbortSignal): WikiIndex;
/**
 * Retain unchanged embedding vectors and expose stable parent-document ranges.
 * The regular embedding builder can use this filtered index as a seed and
 * re-embed only missing/changed documents.
 */
export declare function updateEmbeddingRanges(previous: EmbeddingIndex | null | undefined, nextEntries: readonly WikiEntry[], changedEntryIds?: ReadonlySet<string>): IncrementalEmbeddingUpdate;
/**
 * Apply a manifest delta without mutating the currently published state.
 * Unsupported source changes deliberately return `fallback`; callers should
 * invoke the existing full WikiIndexer rebuild in that case.
 */
export declare function applyIncrementalIndex(options: IncrementalIndexUpdateOptions): Promise<IncrementalIndexResult>;
/** Compatibility aliases for integrations that call this an update/build step. */
export declare const buildIncrementalIndex: typeof applyIncrementalIndex;
export declare const applyIncrementalUpdate: typeof applyIncrementalIndex;
export declare function embeddingRangesFromIndex(index: EmbeddingIndex | null | undefined): Map<string, EmbeddingRange>;
