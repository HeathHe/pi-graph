/**
 * Time-based decay for search ranking.
 *
 * Self-contained mirror of the exponential decay model in
 * src/graph/kg/credibility.ts — but with NO SQLite dependency. Each entry's
 * own date drives the decay, so this runs entirely inside the wiki layer.
 *
 *   factor = floor + (1 - floor) * e^(-λ * age_days),   λ = ln2 / half_life
 *
 * Applied as the final multiplier in WikiIndexer.searchWithMeta, after BM25
 * and hybrid fusion — so fresh knowledge outranks stale knowledge uniformly
 * across both retrieval paths.
 */
import type { WikiEntry } from './wiki-types.js';
/** Compute the decay multiplier for a single entry at time `nowMs`. */
export declare function computeTimeDecayFactor(entry: WikiEntry, nowMs: number): number;
/**
 * Multiply each result's score by its time-decay factor and re-sort.
 * Ties break deterministically by entry id.
 */
export declare function applyTimeDecay(results: Array<{
    entry: WikiEntry;
    score: number;
}>, nowMs: number): Array<{
    entry: WikiEntry;
    score: number;
}>;
