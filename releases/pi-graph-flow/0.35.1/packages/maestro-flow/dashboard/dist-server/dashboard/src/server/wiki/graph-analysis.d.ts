import type { WikiEntry, WikiIndex } from './wiki-types.js';
export interface BrokenLink {
    sourceId: string;
    target: string;
}
export interface WikiGraph {
    /** source entry id → resolved target entry ids */
    forwardLinks: Record<string, string[]>;
    /** target entry id → source entry ids (mirrors WikiIndex.backlinks) */
    backlinks: Record<string, string[]>;
    /** unresolved `[[…]]` mentions */
    brokenLinks: BrokenLink[];
}
export interface HubRank {
    id: string;
    inDegree: number;
}
export interface WikiHealth {
    score: number;
    totals: {
        entries: number;
        brokenLinks: number;
        orphans: number;
        missingTitles: number;
    };
    orphans: string[];
    hubs: HubRank[];
    brokenLinks: BrokenLink[];
    lastUpdated: number;
}
/**
 * Compute forward links + broken links from the current index. Backlinks are
 * already computed by WikiIndexer; we reuse them so the graph is consistent.
 */
export declare function buildGraph(index: WikiIndex): WikiGraph;
/**
 * Entries with zero incoming and zero outgoing resolved links.
 * Virtual entries are excluded — they have no body and no `related`, and would
 * flood the list.
 */
export declare function detectOrphans(graph: WikiGraph, entries: WikiEntry[]): string[];
export declare function detectHubs(graph: WikiGraph, topN?: number): HubRank[];
/**
 * Heuristic health score: 100 minus weighted counts of broken links,
 * orphaned entries, and entries missing titles. Floored at 0.
 *
 * KG virtual entries are excluded from broken-link scoring so that
 * unresolved KG-internal references don't distort the wiki health metric.
 */
export declare function computeHealth(index: WikiIndex, graph: WikiGraph): WikiHealth;
