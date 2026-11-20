/**
 * Wiki Search Bridge — hot-path helper for keyword spec injection.
 *
 * Provides a best-effort wiki search that never throws: tries the resident
 * search daemon first (no heavy imports), falls back to a lazily-loaded
 * WikiIndexer BM25 search. Results are filtered to spec + knowhow entries,
 * score-thresholded, and capped.
 */
export interface WikiSearchHit {
    id: string;
    type: string;
    title: string;
    summary: string;
    score: number;
}
export type WikiSearchSource = 'daemon' | 'indexer' | 'none';
/**
 * Search the wiki knowledge base. Best-effort — never throws.
 * Returns filtered spec + knowhow hits and the source that produced them.
 */
export declare function searchWiki(workflowRoot: string, query: string, opts?: {
    limit?: number;
    minScore?: number;
    daemonTimeoutMs?: number;
    skipEmbedding?: boolean;
    applicableRepoId?: string | null;
}): Promise<{
    hits: WikiSearchHit[];
    source: WikiSearchSource;
}>;
/**
 * Fire-and-forget background init of the WikiIndexer so future searches
 * skip the cold-start cost. Never throws.
 */
export declare function prewarmWikiIndexer(workflowRoot: string): void;
