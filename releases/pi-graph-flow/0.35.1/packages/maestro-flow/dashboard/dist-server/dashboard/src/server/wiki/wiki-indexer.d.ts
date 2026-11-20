import { type WikiGraph } from './graph-analysis.js';
import { type InvertedIndex } from './search.js';
import type { EmbeddingIndex } from './embedding.js';
import type { WikiEntry, WikiFilters, WikiIndex, WikiSearchFilters, WikiNodeType, WikiSearchDiagnostics, WikiSearchDiagnosticsSnapshot, WikiSearchCandidateBudget } from './wiki-types.js';
import { type RecallSnapshot } from './wiki-types.js';
/** Reconcile user-level transcript membership/content at most four minutes apart. */
export declare const CLI_SESSION_RECONCILIATION_INTERVAL_MS: number;
/**
 * Compiled posting payloads remain opt-in until the release benchmark proves
 * the required latency/size gate. Any truthy explicit opt-in is accepted so
 * CI and local profiling can use either `1` or `true`; unset/other values
 * intentionally retain the v8 JSON-entry writer.
 */
export declare function isCompiledSearchCacheEnabled(): boolean;
/** Incremental file indexing is an explicit opt-in and remains fail-closed. */
export declare function isIncrementalSearchIndexEnabled(): boolean;
export interface WikiSearchOptions {
    skipEmbedding?: boolean;
    credibilityFactors?: Map<string, number>;
    filters?: WikiSearchFilters;
    /** Cancels this caller's wait and query embedding without aborting shared cache builds. */
    signal?: AbortSignal;
    /** Optional request-local diagnostics sink; never persisted by the indexer. */
    diagnostics?: WikiSearchDiagnostics;
    /** One boundary-computed candidate budget; adaptive mode is opt-in. */
    candidateBudget?: WikiSearchCandidateBudget;
}
export interface WikiIndexerCloseOptions {
    /** Only dedicated owner processes should tear down the process-global pipeline. */
    disposeEmbeddingPipeline?: boolean;
}
export interface LinkedWorkspaceConfig {
    name: string;
    workflowRoot: string;
    shareTypes: Array<'spec' | 'knowhow' | 'domain' | 'codebase' | 'session'>;
    repoId?: string | null;
    repoName?: string;
    workspaceFence?: string;
}
export type WikiIndexerRole = 'publisher' | 'reader' | 'hermetic';
/** Compatibility aliases retained for callers that used persistence/mode names. */
export type WikiIndexerPersistence = 'filesystem' | 'read-only' | 'memory-only';
export declare const WIKI_INDEXER_ROLES: readonly WikiIndexerRole[];
/** Map the pre-role persistence option to the explicit ownership role. */
export declare function wikiIndexerRoleFromPersistence(persistence: WikiIndexerPersistence | undefined): WikiIndexerRole;
/** Resolve an explicit role first, preserving legacy option behavior. */
export declare function resolveWikiIndexerRole(config: Pick<WikiIndexerConfig, 'role' | 'persistence'>): WikiIndexerRole;
export interface WikiIndexerConfig {
    workflowRoot: string;
    linkedWorkspaces?: LinkedWorkspaceConfig[];
    repository?: {
        repoId: string | null;
        repoName: string;
        alias?: string;
        workspaceFence?: string;
    };
    /** Explicit ownership: publisher writes, reader consumes, hermetic never touches persistence. */
    role?: WikiIndexerRole;
    /**
     * @deprecated Use role. filesystem → publisher, read-only → reader,
     * memory-only → hermetic. The default remains publisher for compatibility.
     */
    persistence?: WikiIndexerPersistence;
    /** Disable user-level Claude/Codex transcript sources for hermetic callers. */
    includeCliSessions?: boolean;
    evidenceRecorder?: (event: WikiEvidenceEvent) => void;
}
export type WikiEvidenceEventName = 'filesystem-cache-read' | 'filesystem-cache-write' | 'filesystem-index-write' | 'embedding-build' | 'embedding-save';
export interface WikiEvidenceEvent {
    event: WikiEvidenceEventName;
    site: string;
    queryId: null;
}
/**
 * WikiIndexer: single source of truth for the unified wiki index.
 *
 * Responsibilities:
 *   1. Walk `.workflow/` for known wiki sources.
 *   2. Parse frontmatter + infer missing fields.
 *   3. Adapt JSONL rows as virtual entries.
 *   4. Build backlinks from `related: [[id]]` frontmatter.
 *   5. Cache index + memoized graph + BM25 index.
 *   6. Single-flight rebuild with invalidate().
 */
export declare class WikiIndexer {
    private readonly workflowRoot;
    private readonly role;
    private readonly persistence;
    private readonly evidenceRecorder;
    private readonly includeCliSessions;
    private readonly currentRepository;
    private readonly linkedWorkspaces;
    private cache;
    private graphCache;
    private searchCache;
    private embeddingCache;
    /** Partial vectors retained by incremental updates until the next build fills gaps. */
    private embeddingSeed;
    private embeddingInflight;
    private embeddingGeneration;
    private embeddingAbort;
    private inflight;
    private incrementalInflight;
    private rebuildGeneration;
    private persistenceInflight;
    private pendingPersistence;
    private mtimeSnapshot;
    /** Paths recorded in mtimeSnapshot, for the warm-path re-stat change check. */
    private lastSnapshotPaths;
    /** Last validated manifest used by the opt-in incremental file path. */
    private incrementalManifest;
    /** Fingerprint of the bounded user-level CLI transcript projection. */
    private cliSessionFingerprint;
    /** Monotonic generation value used to fence rapid publications in one process. */
    private lastIndexGeneration;
    private reconciliationTimer;
    private closing;
    constructor(config: WikiIndexerConfig);
    getWorkflowRoot(): string;
    /** Explicit cache ownership role for lifecycle diagnostics and tests. */
    getRole(): WikiIndexerRole;
    /** Allocate a generation that remains unique even when Date.now() repeats. */
    private allocateIndexGeneration;
    private startPeriodicReconciliation;
    private recordEvidence;
    private captureCliSessionFingerprint;
    get(): Promise<WikiIndex>;
    private runIncrementalRefresh;
    /**
     * Refresh a warm generation from local covered files only. The existing
     * snapshot is still consulted for linked/session/transcript paths because
     * those paths are outside the manifest root and must force a full rebuild.
     */
    private tryIncrementalRefresh;
    private changedSnapshotPaths;
    private isIncrementalSnapshotPath;
    private hasSourceChanges;
    /** Capture every source family the indexer can read, after realpath fencing. */
    private captureSourceSnapshot;
    private tryLoadSearchCache;
    /**
     * Replace cache-era routing/display fields with the current constructor
     * authority. Version 7 is intentionally dual-read: its persisted alias is
     * used only to identify identity-less legacy links, never as result metadata.
     */
    private rehydrateCachedEntries;
    private linkedEntryIsShared;
    private prepareSearchCache;
    private prepareSourceManifest;
    rebuild(): Promise<WikiIndex>;
    private buildIndexCandidate;
    private rebuildUntilCurrent;
    private schedulePersistence;
    private ensurePersistenceDrain;
    private drainPersistence;
    invalidate(_changedAbsPath?: string): void;
    /** Abort and join background index work before a daemon releases ownership. */
    close(options?: WikiIndexerCloseOptions): Promise<void>;
    query(filters: WikiFilters): Promise<WikiEntry[]>;
    groups(filters?: WikiFilters): Promise<Record<WikiNodeType, WikiEntry[]>>;
    getGraph(): Promise<WikiGraph>;
    getSearchIndex(): Promise<InvertedIndex>;
    getSearchIndexWithMeta(): Promise<{
        index: InvertedIndex;
        cacheState: 'cold-build' | 'cache-hit';
    }>;
    searchWithScores(query: string, limit?: number, options?: WikiSearchOptions): Promise<Array<{
        entry: WikiEntry;
        score: number;
    }>>;
    recallSnapshot(query: string, asOf: string, limit?: number): Promise<RecallSnapshot>;
    searchWithMeta(query: string, limit?: number, options?: WikiSearchOptions): Promise<{
        results: Array<{
            entry: WikiEntry;
            score: number;
        }>;
        embeddingUsed: boolean;
        embeddingDocs: number;
        /** Present only when a request-local diagnostics sink was supplied. */
        diagnostics?: WikiSearchDiagnosticsSnapshot;
    }>;
    getEmbeddingIndex(): Promise<EmbeddingIndex | null>;
    private buildEmbeddingsUntilCurrent;
    private loadOrBuildEmbeddings;
    private enrichKgDocForEmbedding;
    search(query: string, limit?: number, options?: WikiSearchOptions): Promise<WikiEntry[]>;
    private scanFiles;
    /**
     * Parse one changed local covered source for the opt-in incremental path.
     * This intentionally mirrors scanFiles/scanVirtual projection semantics and
     * never reaches Session, KG, linked-workspace, or transcript adapters.
     */
    private scanIncrementalSource;
    /**
     * Recursively scan knowhow directory (supports both flat and sub-folder layouts).
     */
    private scanKnowhowDir;
    /**
     * Scan .workflow/domain/glossary.json and produce WikiEntry[] for each term.
     */
    private scanDomain;
    /**
     * Resolve spec directories for all scopes that exist on disk.
     * Returns entries with scoped ID prefix and source path prefix.
     */
    private resolveSpecScopes;
    private scanVirtual;
    private scanCliSessions;
    private scanRunModeSessions;
    private scanLinkedWorkspaces;
    private scanLinkedWorkspace;
    private parseLinkedFileEntry;
    private scanLinkedKnowhowDir;
    private scanLinkedDomain;
    private parseFileEntry;
    private buildBacklinks;
    /**
     * Write a lightweight persistent index to `.workflow/wiki-index.json`.
     * Strips body/raw/ext to keep the file small and fast to parse externally.
     * KG virtual entries get additional truncation to prevent file bloat.
     */
    private prepareIndex;
    isInsideRoot(absPath: string): boolean;
}
/**
 * Fingerprint exactly the user-level stores already authorized by the CLI
 * transcript adapters. Metadata covers discovery/membership; each selected
 * transcript and the Codex title index receives a bounded head/tail digest so
 * appends are visible even when a filesystem preserves mtime.
 */
export declare function cliSessionStoreFingerprint(claudeProjectDir: string, codexRoot: string, projectCwd?: string, options?: {
    maxAgeDays?: number;
    maxFiles?: number;
}): Promise<string>;
export declare function filterEntries(entries: WikiEntry[], filters: WikiFilters): WikiEntry[];
