/**
 * Search candidate budget policy shared by the CLI and dashboard search.
 *
 * A search has one display limit (the user's K) and one provider candidate
 * limit.  The latter is deliberately computed at the request boundary and
 * passed through the provider stack rather than being multiplied by every
 * layer.  Adaptive mode is opt-in (`MAESTRO_SEARCH_ADAPTIVE_BUDGET=1`); the
 * legacy policy remains available so rollout can compare both policies without
 * changing the default result contract.
 */
export declare const SEARCH_CANDIDATE_HARD_CAP: 500;
export declare const SEARCH_CANDIDATE_DEFAULT_MULTIPLIER: 2;
export declare const SEARCH_CANDIDATE_DEFAULT_MINIMUM: 40;
export declare const SEARCH_CANDIDATE_MAX_ESCALATIONS: 1;
export declare const SEARCH_CANDIDATE_ADAPTIVE_ENV: "MAESTRO_SEARCH_ADAPTIVE_BUDGET";
/** Compatibility aliases for provider adapters and rollout probes. */
export declare const MAX_SEARCH_CANDIDATES: 500;
export declare const SEARCH_MAX_CANDIDATES: 500;
export declare const MAX_CANDIDATES: 500;
export declare const SEARCH_ADAPTIVE_BUDGET_ENV: "MAESTRO_SEARCH_ADAPTIVE_BUDGET";
export type SearchCandidateBudgetMode = 'legacy' | 'adaptive';
export type SearchCandidateBudgetSurface = 'search' | 'wiki' | 'mixed' | 'indexer' | 'planned' | 'kg' | 'code' | 'arch-kb';
/**
 * Immutable-by-convention request budget.  `candidateLimit` is the active
 * pass.  `resultLimit` is always the user's requested display K and is never
 * changed by escalation.
 */
export interface SearchCandidateBudget {
    /** User-visible result limit (K). */
    readonly resultLimit: number;
    /** Alias retained for callers that call the user limit simply `limit`. */
    readonly limit: number;
    /** Active provider candidate limit for this pass. */
    readonly candidateLimit: number;
    /** Initial provider candidate limit before a possible second pass. */
    readonly initialCandidateLimit: number;
    /** Absolute provider cap. Always <= SEARCH_CANDIDATE_HARD_CAP. */
    readonly maxCandidateLimit: number;
    /** Alias for maxCandidateLimit used by protocol/diagnostic consumers. */
    readonly hardCap: number;
    /** Current rollout policy. */
    readonly mode: SearchCandidateBudgetMode;
    /** Whether this budget can perform the one adaptive second pass. */
    readonly adaptive: boolean;
    /** Whether this is the escalated second pass. */
    readonly escalated: boolean;
    /** Number of adaptive escalations already consumed (0 or 1). */
    readonly escalationCount: number;
    /** Legacy candidate limit for shadow/rollout comparison. */
    readonly legacyCandidateLimit: number;
    /** Policy surface used to derive legacyCandidateLimit. */
    readonly surface: SearchCandidateBudgetSurface;
}
export interface SearchCandidateBudgetOptions {
    /** Explicit mode wins over MAESTRO_SEARCH_ADAPTIVE_BUDGET. */
    mode?: SearchCandidateBudgetMode;
    adaptive?: boolean;
    surface?: SearchCandidateBudgetSurface;
    multiplier?: number;
    minimum?: number;
    hardCap?: number;
    /** Test/embedding callers may provide an environment object explicitly. */
    env?: Readonly<Record<string, string | undefined>>;
}
/** Candidate observations used to decide whether a second pass can help. */
export interface SearchCandidateCounts {
    /** Number of raw candidates returned by the provider. */
    candidateCount?: number;
    /** Alias for candidateCount used by some provider adapters. */
    returnedCount?: number;
    /** Number of unique candidates before eligibility filters. */
    uniqueCandidateCount?: number;
    /** Number of unique candidates surviving authorization/facets/caps. */
    eligibleUniqueCount?: number;
    /** Alias accepted at adapter boundaries. */
    eligibleUniqueCandidates?: number;
    /** Explicit saturation signal from a provider. */
    saturated?: boolean;
}
export interface SearchCandidateShadowComparison {
    legacyCandidateLimit: number;
    adaptiveCandidateLimit: number;
    legacyCount: number;
    adaptiveCount: number;
    topLimit: number;
    topIdsEqual: boolean;
    overlapCount: number;
}
/** True only for the explicit opt-in rollout flag. */
export declare function isAdaptiveSearchBudgetEnabled(env?: Readonly<Record<string, string | undefined>>): boolean;
/**
 * Return the pre-adaptive candidate policy used by each current call site.
 * Keeping this in one pure function lets the default path remain byte-for-
 * byte compatible while adaptive callers stop applying these multipliers.
 */
export declare function legacySearchCandidateLimit(limit: number, surface?: SearchCandidateBudgetSurface, hardCap?: number): number;
/** Compute the one-pass adaptive candidate count. */
export declare function adaptiveSearchCandidateLimit(limit: number, options?: Pick<SearchCandidateBudgetOptions, 'multiplier' | 'minimum' | 'hardCap'>): number;
/**
 * Compute a request budget exactly once.  If no mode is supplied, the explicit
 * environment opt-in selects adaptive; otherwise legacy is selected.
 */
export declare function computeSearchCandidateBudget(limit: number, options?: SearchCandidateBudgetOptions | boolean): SearchCandidateBudget;
/** Naming aliases used by adapters and tests. */
export declare const createSearchCandidateBudget: typeof computeSearchCandidateBudget;
export declare const createCandidateBudget: typeof computeSearchCandidateBudget;
export declare const computeCandidateBudget: typeof computeSearchCandidateBudget;
export declare const getSearchCandidateBudget: typeof computeSearchCandidateBudget;
export declare const getCandidateBudget: typeof computeSearchCandidateBudget;
export declare const createAdaptiveSearchCandidateBudget: (limit: number, options?: Omit<SearchCandidateBudgetOptions, "mode" | "adaptive">) => SearchCandidateBudget;
export declare const createLegacySearchCandidateBudget: (limit: number, options?: Omit<SearchCandidateBudgetOptions, "mode" | "adaptive">) => SearchCandidateBudget;
/** Whether the active provider pass reached its candidate ceiling. */
export declare function isSearchCandidateBudgetSaturated(budget: SearchCandidateBudget, counts: SearchCandidateCounts): boolean;
export declare function shouldEscalateSearchCandidateBudget(budgetOrCounts: SearchCandidateBudget | SearchCandidateCounts, countsOrBudget: SearchCandidateCounts | SearchCandidateBudget | number, candidateCount?: number): boolean;
/** Return a new budget for the one allowed 2x pass, or the same budget. */
export declare function escalateSearchCandidateBudget(budgetOrCounts: SearchCandidateBudget | SearchCandidateCounts, countsOrBudget: SearchCandidateCounts | SearchCandidateBudget | number, candidateCount?: number): SearchCandidateBudget;
export declare const nextSearchCandidateBudget: typeof escalateSearchCandidateBudget;
export declare const nextCandidateBudget: typeof escalateSearchCandidateBudget;
export declare const shouldEscalateCandidateBudget: typeof shouldEscalateSearchCandidateBudget;
export declare const escalateCandidateBudget: typeof escalateSearchCandidateBudget;
/** Count stable unique IDs without changing provider ordering. */
export declare function countUniqueSearchCandidates<T>(candidates: readonly T[], identity?: (candidate: T) => unknown): number;
export declare const countUniqueCandidates: typeof countUniqueSearchCandidates;
export declare const countUniqueCandidateIds: typeof countUniqueSearchCandidates;
/**
 * Compare legacy and adaptive Top-N IDs for shadow rollout.  The comparison is
 * pure and does not alter either result list or any public result field.
 */
export declare function compareSearchCandidateResults(legacyIds: readonly string[], adaptiveIds: readonly string[], budget: SearchCandidateBudget | number): SearchCandidateShadowComparison;
export declare const compareSearchCandidateBudget: typeof compareSearchCandidateResults;
export declare const compareCandidateBudgetShadow: typeof compareSearchCandidateResults;
