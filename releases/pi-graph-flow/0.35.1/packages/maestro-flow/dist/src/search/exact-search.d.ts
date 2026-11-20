import { type RepositoryContext } from '../repository/context.js';
/** Fixed-string exact search defaults and hard ceilings. */
export declare const EXACT_DEFAULT_LIMIT = 20;
export declare const EXACT_MAX_LIMIT = 500;
export declare const EXACT_DEFAULT_TIMEOUT_MS = 5000;
export declare const EXACT_MAX_TIMEOUT_MS = 30000;
export declare const EXACT_DEFAULT_MAX_BYTES = 1048576;
export declare const EXACT_MAX_BYTES: number;
export declare const EXACT_PREVIEW_MAX_CHARS = 1000;
/** A single literal occurrence from a governed repository scope. */
export interface ExactSearchResult {
    /** Always relative to the repository that owns the result. */
    filePath: string;
    /** One-based source line. */
    line: number;
    /** One-based Unicode code-point column. */
    column: number;
    /** Bounded source line preview. */
    preview: string;
    /** Linked workspace alias; omitted for the current repository. */
    workspace?: string;
    /** Stable linked-scope fence; never an absolute filesystem path. */
    workspaceFence?: string;
}
/** Result of a standalone exact pass. */
export interface ExactSearchOutcome {
    query: string;
    results: ExactSearchResult[];
    /** True when any result/byte/timeout bound stopped collection. */
    truncated: boolean;
    /** True when the wall-clock bound stopped collection. */
    timedOut: boolean;
    /** Number of ripgrep stdout bytes consumed (bounded). */
    bytesUsed: number;
}
/** Options for the standalone literal search. */
export interface ExactSearchOptions {
    /** Host repository root or a nested path from which it is resolved. */
    projectRoot?: string;
    /** Existing host-resolved target; used by command and trusted callers. */
    targetRepository?: RepositoryContext;
    /** Human-facing repository selector, resolved by repository authority. */
    repo?: string;
    /** Linked workspace alias/name selector. */
    workspace?: string;
    /** Explicitly include linked codebase scopes. */
    includeLinkedCode?: boolean;
    /** Maximum occurrences returned across all scopes. */
    limit?: number;
    /** Alias accepted by programmatic callers for the result cap. */
    maxResults?: number;
    /** Alias accepted by programmatic callers for the result cap. */
    resultLimit?: number;
    /** Wall-clock timeout for the whole governed search. */
    timeoutMs?: number;
    /** Alias accepted by programmatic callers for the timeout. */
    timeout?: number;
    /** Maximum ripgrep stdout bytes consumed across all scopes. */
    maxBytes?: number;
    /** Alias accepted by programmatic callers for the response-byte cap. */
    byteCap?: number;
    /** Alias accepted by programmatic callers for the response-byte cap. */
    maxResponseBytes?: number;
    /** Test/host cancellation. */
    signal?: AbortSignal;
}
/** Public for focused tests and diagnostics; the command itself uses only argv. */
export interface ExactRipgrepArgsOptions {
    root: string;
    query: string;
    /** Explicitly pass ignore files so temporary/non-Git repositories are governed too. */
    gitIgnoreFile?: string;
    maestroIgnoreFile?: string;
    excludedNestedRoots?: readonly string[];
}
/**
 * Build the complete fixed-string ripgrep argv. The `--` before the query is
 * deliberate: a user query beginning with `-` must remain a literal pattern.
 */
export declare function buildExactRipgrepArgs(options: ExactRipgrepArgsOptions): string[];
/**
 * Search governed repository source with bundled ripgrep. This is deliberately
 * standalone and never invokes the Wiki/KG providers or normal fusion.
 */
export declare function runExactSearch(query: string, options?: ExactSearchOptions): Promise<ExactSearchOutcome>;
/** Backward-friendly aliases for callers that use either operation name. */
export declare const searchExact: typeof runExactSearch;
export declare const exactSearch: typeof runExactSearch;
export declare const runExactFileSearch: typeof runExactSearch;
/** Parse one ripgrep JSON match event into every occurrence on that line. */
export declare function parseExactRipgrepJsonLine(line: string, root: string, metadata?: Pick<ExactSearchResult, 'workspace' | 'workspaceFence'>): ExactSearchResult[];
/** Normalize and validate exact caps for both CLI and programmatic callers. */
export declare function normalizeExactLimits(options: ExactSearchOptions): {
    maxResults: number;
    timeoutMs: number;
    maxBytes: number;
};
//# sourceMappingURL=exact-search.d.ts.map