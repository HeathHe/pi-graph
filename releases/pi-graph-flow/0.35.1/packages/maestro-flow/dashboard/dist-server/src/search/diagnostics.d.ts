/** Stable schema identifier for request-scoped search diagnostics. */
export declare const SEARCH_DIAGNOSTICS_SCHEMA: "maestro-search-diagnostics/1.0";
/** Diagnostics are deliberately small: they are for attribution, not tracing. */
export declare const SEARCH_DIAGNOSTICS_MAX_BYTES: number;
export declare const SEARCH_DIAGNOSTICS_MAX_PHASES = 32;
export declare const SEARCH_DIAGNOSTICS_MAX_FALLBACKS = 16;
export declare const SEARCH_DIAGNOSTICS_MAX_TOKEN_LENGTH = 64;
export type SearchDiagnosticProvider = 'daemon' | 'indexer' | 'mixed' | 'kg' | 'arch-kb' | 'none';
export type SearchDiagnosticCacheState = 'hit' | 'miss' | 'stale' | 'unknown';
/**
 * A phase is intentionally represented by a small fixed-shape record.  Do not
 * add paths, query text, or free-form error messages here: diagnostics can be
 * printed by untrusted callers and are never a persistence format.
 */
export interface SearchDiagnosticPhase {
    phase: string;
    durationMs: number;
    candidateCount?: number;
}
/** Reason-coded fallback attribution; values are sanitized to bounded tokens. */
export interface SearchDiagnosticFallback {
    source: string;
    reason: string;
}
/** JSON-safe request diagnostics exposed by `--diagnostics`. */
export interface SearchCandidateBudgetDiagnostics {
    mode: 'legacy' | 'adaptive';
    requestedLimit: number;
    initialCandidateLimit: number;
    candidateLimit: number;
    hardCap: number;
    escalated: boolean;
    legacyCandidateLimit: number;
}
export interface SearchDiagnostics {
    schemaVersion: typeof SEARCH_DIAGNOSTICS_SCHEMA;
    requestId: string;
    durationMs: number;
    phases: SearchDiagnosticPhase[];
    fallbacks: SearchDiagnosticFallback[];
    provider?: SearchDiagnosticProvider;
    cacheState?: SearchDiagnosticCacheState;
    embeddingUsed?: boolean;
    embeddingDocs?: number;
    resultCount?: number;
    candidateCount?: number;
    /** Unique candidates after authorization/facet/cap filtering. */
    eligibleCandidateCount?: number;
    /** One request budget snapshot; absent for ordinary non-budget callers. */
    candidateBudget?: SearchCandidateBudgetDiagnostics;
    truncated?: boolean;
}
/**
 * The intentionally tiny interface consumed by WikiIndexer.  Keeping this
 * structural lets the dashboard package record diagnostics without importing
 * the root CLI package (the dashboard is compiled first).
 */
export interface SearchDiagnosticsRecorder {
    readonly requestId: string;
    recordPhase(phase: string, durationMs: number, candidateCount?: number): void;
    /** Short aliases retained for lightweight consumers. */
    phase(phase: string, durationMs: number, candidateCount?: number): void;
    recordFallback(source: string, reason: string): void;
    fallback(source: string, reason: string): void;
    setProvider(provider: SearchDiagnosticProvider): void;
    setCacheState(state: SearchDiagnosticCacheState): void;
    setEmbedding(used: boolean, docs: number): void;
    setResultCount(count: number): void;
    setCandidateCount(count: number): void;
    setEligibleCandidateCount?(count: number): void;
    setCandidateBudget?(budget: SearchCandidateBudgetDiagnostics): void;
    merge(value: unknown): void;
    snapshot(): SearchDiagnostics;
    toJSON(): SearchDiagnostics;
    finish(): SearchDiagnostics;
}
/** Alias used by callers that treat diagnostics as a per-request context. */
export type SearchDiagnosticsContext = SearchDiagnosticsRecorder;
/**
 * Validate and sanitize diagnostics crossing a daemon/CLI boundary. Unknown
 * fields are ignored so a newer daemon can safely answer an older client.
 */
export declare function sanitizeSearchDiagnostics(value: unknown): SearchDiagnostics | null;
/** Runtime type guard for compatible daemon responses. */
export declare function isSearchDiagnostics(value: unknown): value is SearchDiagnostics;
/** Naming aliases for protocol/client callers that use normalize terminology. */
export declare const normalizeSearchDiagnostics: typeof sanitizeSearchDiagnostics;
export declare const createSearchDiagnosticsContext: typeof createSearchDiagnostics;
export type SearchDiagnosticsMeta = SearchDiagnostics;
/** Create an in-memory, bounded recorder for exactly one search request. */
export declare function createSearchDiagnostics(options?: {
    requestId?: string;
}): SearchDiagnosticsRecorder;
/** Finish a recorder when the caller wants an explicit terminal snapshot. */
export declare function finishSearchDiagnostics(recorder: SearchDiagnosticsRecorder): SearchDiagnostics;
/** Record an async phase while preserving the original result/error. */
export declare function withSearchDiagnosticPhase<T>(recorder: SearchDiagnosticsRecorder | undefined, phase: string, work: Promise<T> | (() => Promise<T>), candidateCount?: number): Promise<T>;
/** Record a synchronous phase without leaking its return value into the API. */
export declare function recordSearchDiagnosticPhase<T>(recorder: SearchDiagnosticsRecorder | undefined, phase: string, work: () => T, candidateCount?: number): T;
/**
 * Return a sanitized object suitable for embedding in a larger JSON response.
 * The result is guaranteed to stay under the diagnostics byte budget; optional
 * fields and then tail phases/fallbacks are removed if a custom token somehow
 * causes the budget to be exceeded.
 */
export declare function boundedSearchDiagnostics(value: unknown): SearchDiagnostics | null;
/** Serialize a bounded diagnostics object for stderr or protocol tests. */
export declare function serializeSearchDiagnostics(value: unknown): string;
