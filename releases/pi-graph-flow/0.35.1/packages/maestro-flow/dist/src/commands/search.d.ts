/**
 * Search Command — Unified knowledge search across wiki + code.
 *
 * Default: mixed results (wiki + code interleaved by normalized score).
 * --code: code graph results only (no wiki).
 * --wiki-only: wiki results only (no code search).
 *
 * Scoring: multi-signal normalization inspired by codebase-memory-mcp.
 *   Wiki:  BM25F score + type boost (spec > knowhow > note)
 *   Code:  BM25 score + kind boost + name-match bonus
 *   Merge: rank interleave (ordering) + per-source normalized relevance (display)
 *
 * Per-source caps: session ≤3, scratch ≤3 to prevent low-value source spam.
 */
import type { Command } from 'commander';
import type { WikiEntry, WikiNodeType } from '#maestro-dashboard/wiki/wiki-types.js';
import { type RepositoryContext } from '../repository/context.js';
import { type ScoredArchKbEntry } from '../arch-kb/index.js';
import { type SearchDiagnosticsContext } from '../search/diagnostics.js';
import { type SearchCandidateBudget } from '../search/candidate-budget.js';
/** A single unified search result with BM25 score and snippet. */
export interface SearchResult {
    id: string;
    type: WikiNodeType;
    title: string;
    category: string | null;
    summary: string;
    score: number | null;
    snippet: string | null;
    source: WikiEntry['source'];
    sourceRef?: string | null;
    workspace?: string;
    /** Provider-observed authorization metadata (when exposed by the source). */
    authorized?: boolean;
    /** Provider-observed lifecycle status (when exposed by the source). */
    status?: string;
    /** Provider-observed provenance (when exposed by the source). */
    provenance?: {
        source: string;
        path: string;
    } | null;
    repoId?: string | null;
    repoName?: string;
    alias?: string;
    workspaceFence?: string;
    appliesToRepoIds?: string[] | null;
    confidence?: string;
    /** Session/Run topology — present only on run-mode session and run entries. */
    sessionId?: string;
    runId?: string;
    runCount?: number;
    related?: string[];
    /** Why this wiki candidate entered the final list; does not alter score. */
    selectionReason?: 'relevance' | 'diversity' | 'exploration';
}
/** A code search result from CodeGraph. */
export interface CodeSearchResult {
    id: string;
    kind: string;
    name: string;
    filePath: string;
    line: number | null;
    score: number | null;
    signature?: string;
    /** Linked workspace provenance；本地 CodeGraph 结果不设置。 */
    workspace?: string;
    /** Linked 结果的稳定 workspace 边界。 */
    workspaceFence?: string;
    /** Provider-observed authorization metadata (when exposed by the source). */
    authorized?: boolean;
    /** Provider-observed lifecycle status (when exposed by the source). */
    status?: string;
    /** Provider-observed provenance (when exposed by the source). */
    provenance?: {
        source: string;
        path: string;
    } | null;
}
/** Availability of the codegraph index backing code search. */
export type CodeIndexStatus = 'ok' | 'not-initialized' | 'empty' | 'error';
export type SearchExecutionMode = 'default' | 'read-only-probe';
export type SearchEvidenceEventName = 'daemon-lookup' | 'daemon-start' | 'credibility-hit-write';
export interface SearchEvidenceEvent {
    event: SearchEvidenceEventName;
    site: string;
    queryId: string | null;
}
/** Code search results plus index availability for actionable feedback. */
export interface CodeSearchOutcome {
    results: CodeSearchResult[];
    status: CodeIndexStatus;
    linkedFailures?: LinkedCodeSearchFailure[];
}
export interface LinkedCodeSearchFailure {
    workspace: string;
    message: string;
}
export interface LinkedCodeSearchOutcome {
    results: CodeSearchResult[];
    failures: LinkedCodeSearchFailure[];
}
/** Actionable hint for a degraded code index, or null when healthy. */
export declare function codeIndexHint(status: CodeIndexStatus): string | null;
/** Options for runUnifiedSearch — wiki facets and result cap. */
export interface UnifiedSearchOptions {
    type?: string;
    category?: string;
    tag?: string;
    /** Artifact kind projected by Session/Run virtual entries. */
    kind?: string;
    keyword?: string;
    workspace?: string;
    limit: number;
    /** 显式包含已授权的 linked CodeGraph 数据库；默认 false。 */
    includeLinkedCode?: boolean;
    /** Internal evaluation mode that forbids daemon, persistence, embeddings, and hit writes. */
    executionMode?: SearchExecutionMode;
    /** Include entries with status="deprecated" (superseded). Default: excluded. */
    includeDeprecated?: boolean;
    /** Human-facing target repository selector. Explicit selection also filters origin. */
    repo?: string;
    /** Pre-resolved target used by host-owned callers. */
    targetRepository?: RepositoryContext;
    /** Optional raw recorder used by the built adapter; absent in normal CLI calls. */
    evidenceRecorder?: (event: SearchEvidenceEvent) => void;
    /** Query identity attached to raw evidence events. */
    evidenceQueryId?: string | null;
    /** Wiki candidate selection policy. Default: balanced. */
    diversity?: 'balanced' | 'off';
    /** Mixed search defers impressions until cross-source truncation is complete. */
    deferImpressions?: boolean;
    /** Final mixed display size used when reserving an exploration candidate. */
    explorationLimit?: number;
    /** Optional request-local diagnostics collector; omitted on hot paths. */
    diagnostics?: SearchDiagnosticsContext;
    /** One request-bound candidate budget; adaptive mode is opt-in. */
    candidateBudget?: SearchCandidateBudget;
}
/**
 * Unified knowledge search — BM25F ranking via WikiIndexer, with type/category
 * filtering and per-source deduplication.
 */
export interface SearchMeta {
    embeddingUsed: boolean;
    embeddingDocs: number;
    diversityApplied?: boolean;
    explorationUsed?: boolean;
}
export declare function getLastSearchMeta(): SearchMeta;
interface ScoredWikiCandidate {
    entry: WikiEntry;
    score: number;
}
interface SelectedWikiCandidate extends ScoredWikiCandidate {
    selectionReason: 'relevance' | 'diversity' | 'exploration';
}
/**
 * Stable wiki selection: identity/family caps first, then high-lambda MMR.
 * One final slot may explore a lower-exposure candidate above a strict
 * relevance floor. Exposure never changes the relevance score.
 */
export declare function selectDiverseWikiCandidates(filtered: ScoredWikiCandidate[], options: {
    limit: number;
    applyCaps: boolean;
    diversity?: 'balanced' | 'off';
    impressions?: Map<string, number>;
    explorationLimit?: number;
}): SelectedWikiCandidate[];
export declare function runUnifiedSearch(q: string, opts: UnifiedSearchOptions & {
    skipEmbedding?: boolean;
}): Promise<SearchResult[]>;
/** A KG unified search result from MaestroGraph. */
export interface KgSearchResult {
    /** Canonical ID accepted by `maestro load` when one exists. */
    id: string;
    /** Stable MaestroGraph identity used for graph traversal and usage attribution. */
    graphId: string;
    /** Backward-compatible identities accepted as aliases by callers. */
    aliases: string[];
    sourceType: string;
    kind: string;
    name: string;
    definition: string;
    filePath: string;
    score: number;
    category: string;
    status: string;
    selectionReason: 'relevance' | 'diversity';
}
export interface KgSearchOptions {
    type?: string;
    codeOnly?: boolean;
    category?: string;
    includeDeprecated?: boolean;
    diversity?: 'balanced' | 'off';
    /** Request-local diagnostics; omitted by hooks and ordinary callers. */
    diagnostics?: SearchDiagnosticsContext;
    /** One boundary-computed candidate budget; adaptive mode is opt-in. */
    candidateBudget?: SearchCandidateBudget;
}
export declare function selectDiverseKgResults(candidates: KgSearchResult[], limit: number, diversity?: 'balanced' | 'off'): KgSearchResult[];
export declare function runKgSearch(q: string, limit: number, recordImpressions?: boolean, projectRoot?: string, options?: KgSearchOptions): Promise<{
    results: KgSearchResult[];
    summary: Record<string, number>;
}>;
/**
 * 以确定性、单句柄生命周期搜索显式共享的 linked CodeGraph 数据库。
 * 每个数据库独立隔离。
 */
export declare function runLinkedCodeSearch(q: string, limit: number, projectRoot?: string): Promise<LinkedCodeSearchOutcome>;
export declare function runCodeSearch(q: string, limit: number, skipEmbedding?: boolean, includeLinkedCode?: boolean, projectRoot?: string, executionMode?: SearchExecutionMode, diagnostics?: SearchDiagnosticsContext, candidateBudget?: SearchCandidateBudget): Promise<CodeSearchOutcome>;
/**
 * 在互不校准 raw score 的 CodeGraph providers 之间按 ordinal 公平取样。
 * provider 顺序固定为 local，其后为 workspace name 升序的 linked groups。
 */
export declare function interleaveCodeProviders(localResults: CodeSearchResult[], linkedResults: CodeSearchResult[], limit: number): CodeSearchResult[];
export interface MixedSearchOutcome {
    candidateLimit: number;
    wikiResults: SearchResult[];
    codeOutcome: CodeSearchOutcome;
    templateResults: ScoredArchKbEntry[];
    results: MergedResult[];
}
export interface MixedSearchDependencies {
    wikiSearch: typeof runUnifiedSearch;
    codeSearch: typeof runCodeSearch;
    archKbSearch: typeof runArchKbSearch;
    merge: typeof mergeAndNormalize;
}
/** Search bundled architecture templates without touching the project index. */
export declare function runArchKbSearch(q: string, limit: number): ScoredArchKbEntry[];
/**
 * 扩大 mixed 搜索的源内候选池，但只在 legacy rank fusion 后按用户 limit 截断。
 */
export declare function runMixedSearch(q: string, options: UnifiedSearchOptions & {
    skipEmbedding?: boolean;
}, dependencies?: Partial<MixedSearchDependencies>): Promise<MixedSearchOutcome>;
export declare function registerSearchCommand(program: Command): void;
export interface MergedResult {
    source: 'wiki' | 'code' | 'arch-kb';
    /** Stable entry id — usable with `maestro load --id`. */
    id: string;
    sourceRef?: string | null;
    kind: string;
    name: string;
    detail: string;
    /** Interleave ordering value — rank-normalized position × source weight. */
    rank: number;
    /** Real normalized relevance within the source (finalScore / source max, 0..1). */
    score: number;
    snippet?: string;
    summary?: string;
    signature?: string;
    workspace?: string;
    /** Provider-observed authorization metadata (when exposed by the source). */
    authorized?: boolean;
    /** Provider-observed lifecycle status (when exposed by the source). */
    status?: string;
    /** Provider-observed provenance (when exposed by the source). */
    provenance?: {
        source: string;
        path: string;
    } | null;
    repoId?: string | null;
    repoName?: string;
    alias?: string;
    workspaceFence?: string;
    appliesToRepoIds?: string[] | null;
    category?: string;
    confidence?: string;
    /** Unified load command for opening an Arch-KB result. */
    openCommand?: string;
    /** Dedicated command for exact template search. */
    searchCommand?: string;
    /** Arch-KB entries are reference material, never current-project facts. */
    referenceOnly?: boolean;
    projectRelated?: boolean;
    /** Session/Run topology — present only on run-mode session and run entries. */
    sessionId?: string;
    runId?: string;
    runCount?: number;
    related?: string[];
    selectionReason?: 'relevance' | 'diversity' | 'exploration';
}
export declare function mergeAndNormalize(wiki: SearchResult[], code: CodeSearchResult[], limit: number, query?: string, templateResults?: ScoredArchKbEntry[]): MergedResult[];
export {};
//# sourceMappingURL=search.d.ts.map