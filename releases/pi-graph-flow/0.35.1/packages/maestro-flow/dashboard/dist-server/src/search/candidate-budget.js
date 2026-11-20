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
export const SEARCH_CANDIDATE_HARD_CAP = 500;
export const SEARCH_CANDIDATE_DEFAULT_MULTIPLIER = 2;
export const SEARCH_CANDIDATE_DEFAULT_MINIMUM = 40;
export const SEARCH_CANDIDATE_MAX_ESCALATIONS = 1;
export const SEARCH_CANDIDATE_ADAPTIVE_ENV = 'MAESTRO_SEARCH_ADAPTIVE_BUDGET';
/** Compatibility aliases for provider adapters and rollout probes. */
export const MAX_SEARCH_CANDIDATES = SEARCH_CANDIDATE_HARD_CAP;
export const SEARCH_MAX_CANDIDATES = SEARCH_CANDIDATE_HARD_CAP;
export const MAX_CANDIDATES = SEARCH_CANDIDATE_HARD_CAP;
export const SEARCH_ADAPTIVE_BUDGET_ENV = SEARCH_CANDIDATE_ADAPTIVE_ENV;
function finiteInteger(value, fallback = 0) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.trunc(value);
}
function normalizeLimit(value, hardCap) {
    return Math.min(hardCap, Math.max(0, finiteInteger(value)));
}
function normalizeHardCap(value) {
    const requested = finiteInteger(value, SEARCH_CANDIDATE_HARD_CAP);
    return Math.min(SEARCH_CANDIDATE_HARD_CAP, Math.max(1, requested));
}
function normalizeMultiplier(value) {
    const multiplier = typeof value === 'number' && Number.isFinite(value)
        ? value
        : SEARCH_CANDIDATE_DEFAULT_MULTIPLIER;
    return Math.max(1, multiplier);
}
function normalizeMinimum(value, hardCap) {
    const minimum = finiteInteger(value, SEARCH_CANDIDATE_DEFAULT_MINIMUM);
    return Math.min(hardCap, Math.max(0, minimum));
}
/** True only for the explicit opt-in rollout flag. */
export function isAdaptiveSearchBudgetEnabled(env = (typeof process === 'undefined' ? {} : process.env)) {
    return env[SEARCH_CANDIDATE_ADAPTIVE_ENV] === '1';
}
/**
 * Return the pre-adaptive candidate policy used by each current call site.
 * Keeping this in one pure function lets the default path remain byte-for-
 * byte compatible while adaptive callers stop applying these multipliers.
 */
export function legacySearchCandidateLimit(limit, surface = 'search', hardCap = SEARCH_CANDIDATE_HARD_CAP) {
    const cap = normalizeHardCap(hardCap);
    const normalized = normalizeLimit(limit, cap);
    if (normalized === 0)
        return 0;
    switch (surface) {
        case 'mixed': return Math.min(cap, Math.max(normalized * 3, 60));
        case 'kg': return Math.min(cap, Math.max(normalized * 4, 40));
        case 'indexer':
        case 'planned': return Math.min(cap, Math.max(normalized * 3, 60));
        case 'code':
        case 'arch-kb': return normalized;
        case 'search':
        case 'wiki':
        default: return Math.min(cap, Math.max(normalized * 2, 40));
    }
}
/** Compute the one-pass adaptive candidate count. */
export function adaptiveSearchCandidateLimit(limit, options = {}) {
    const cap = normalizeHardCap(options.hardCap);
    const normalized = normalizeLimit(limit, cap);
    if (normalized === 0)
        return 0;
    const multiplier = normalizeMultiplier(options.multiplier);
    const minimum = normalizeMinimum(options.minimum, cap);
    return Math.min(cap, Math.max(Math.ceil(normalized * multiplier), minimum));
}
/**
 * Compute a request budget exactly once.  If no mode is supplied, the explicit
 * environment opt-in selects adaptive; otherwise legacy is selected.
 */
export function computeSearchCandidateBudget(limit, options = {}) {
    const policy = typeof options === 'boolean' ? { adaptive: options } : options;
    const hardCap = normalizeHardCap(policy.hardCap);
    const surface = policy.surface ?? 'search';
    const normalizedLimit = normalizeLimit(limit, hardCap);
    const mode = policy.mode
        ?? (policy.adaptive === undefined
            ? (isAdaptiveSearchBudgetEnabled(policy.env) ? 'adaptive' : 'legacy')
            : policy.adaptive ? 'adaptive' : 'legacy');
    const optionsForAdaptive = policy;
    const adaptive = mode === 'adaptive';
    const legacyCandidateLimit = legacySearchCandidateLimit(normalizedLimit, surface, hardCap);
    const initialCandidateLimit = adaptive
        ? adaptiveSearchCandidateLimit(normalizedLimit, optionsForAdaptive)
        : legacyCandidateLimit;
    return {
        resultLimit: normalizedLimit,
        limit: normalizedLimit,
        candidateLimit: initialCandidateLimit,
        initialCandidateLimit,
        maxCandidateLimit: hardCap,
        hardCap,
        mode,
        adaptive,
        escalated: false,
        escalationCount: 0,
        legacyCandidateLimit,
        surface,
    };
}
/** Naming aliases used by adapters and tests. */
export const createSearchCandidateBudget = computeSearchCandidateBudget;
export const createCandidateBudget = computeSearchCandidateBudget;
export const computeCandidateBudget = computeSearchCandidateBudget;
export const getSearchCandidateBudget = computeSearchCandidateBudget;
export const getCandidateBudget = computeSearchCandidateBudget;
export const createAdaptiveSearchCandidateBudget = (limit, options = {}) => computeSearchCandidateBudget(limit, {
    ...options,
    mode: 'adaptive',
});
export const createLegacySearchCandidateBudget = (limit, options = {}) => computeSearchCandidateBudget(limit, {
    ...options,
    mode: 'legacy',
});
function observationCount(count) {
    const value = count.candidateCount ?? count.returnedCount ?? count.uniqueCandidateCount;
    return Math.max(0, finiteInteger(value));
}
function eligibleCount(count) {
    const value = count.eligibleUniqueCount
        ?? count.eligibleUniqueCandidates
        ?? count.uniqueCandidateCount
        ?? count.returnedCount
        ?? count.candidateCount;
    return Math.max(0, finiteInteger(value));
}
/** Whether the active provider pass reached its candidate ceiling. */
export function isSearchCandidateBudgetSaturated(budget, counts) {
    if (counts.saturated === true)
        return true;
    if (counts.saturated === false)
        return false;
    return observationCount(counts) >= budget.candidateLimit;
}
/**
 * Escalate exactly once, and only when the first pass is both underfilled after
 * eligibility/deduplication and saturated.  A sparse provider cannot benefit
 * from asking for more, and a full eligible result must never trigger work.
 */
function budgetAndCounts(budgetOrCounts, countsOrBudget, candidateCount) {
    if ('candidateLimit' in budgetOrCounts) {
        return {
            budget: budgetOrCounts,
            counts: typeof countsOrBudget === 'number'
                ? { eligibleUniqueCount: countsOrBudget, candidateCount }
                : ('candidateLimit' in countsOrBudget ? {} : countsOrBudget),
        };
    }
    if (typeof countsOrBudget === 'object' && countsOrBudget !== null && 'candidateLimit' in countsOrBudget) {
        return { budget: countsOrBudget, counts: budgetOrCounts };
    }
    return null;
}
export function shouldEscalateSearchCandidateBudget(budgetOrCounts, countsOrBudget, candidateCount) {
    const pair = budgetAndCounts(budgetOrCounts, countsOrBudget, candidateCount);
    if (!pair)
        return false;
    const { budget, counts } = pair;
    if (!budget.adaptive)
        return false;
    if (budget.escalated || budget.escalationCount >= SEARCH_CANDIDATE_MAX_ESCALATIONS)
        return false;
    if (budget.candidateLimit <= 0 || budget.candidateLimit >= budget.maxCandidateLimit)
        return false;
    if (eligibleCount(counts) >= budget.resultLimit)
        return false;
    return isSearchCandidateBudgetSaturated(budget, counts);
}
/** Return a new budget for the one allowed 2x pass, or the same budget. */
export function escalateSearchCandidateBudget(budgetOrCounts, countsOrBudget, candidateCount) {
    const pair = budgetAndCounts(budgetOrCounts, countsOrBudget, candidateCount);
    if (!pair) {
        return ('candidateLimit' in budgetOrCounts)
            ? budgetOrCounts
            : (typeof countsOrBudget === 'object' && countsOrBudget !== null && 'candidateLimit' in countsOrBudget
                ? countsOrBudget
                : computeSearchCandidateBudget(0, { mode: 'adaptive' }));
    }
    const { budget, counts } = pair;
    if (!shouldEscalateSearchCandidateBudget(budget, counts))
        return budget;
    const candidateLimit = Math.min(budget.maxCandidateLimit, Math.max(budget.candidateLimit, budget.candidateLimit * 2));
    return {
        ...budget,
        candidateLimit,
        escalated: true,
        escalationCount: budget.escalationCount + 1,
    };
}
export const nextSearchCandidateBudget = escalateSearchCandidateBudget;
export const nextCandidateBudget = escalateSearchCandidateBudget;
export const shouldEscalateCandidateBudget = shouldEscalateSearchCandidateBudget;
export const escalateCandidateBudget = escalateSearchCandidateBudget;
/** Count stable unique IDs without changing provider ordering. */
export function countUniqueSearchCandidates(candidates, identity = candidate => candidate) {
    const seen = new Set();
    for (const candidate of candidates)
        seen.add(identity(candidate));
    return seen.size;
}
export const countUniqueCandidates = countUniqueSearchCandidates;
export const countUniqueCandidateIds = countUniqueSearchCandidates;
/**
 * Compare legacy and adaptive Top-N IDs for shadow rollout.  The comparison is
 * pure and does not alter either result list or any public result field.
 */
export function compareSearchCandidateResults(legacyIds, adaptiveIds, budget) {
    const topLimit = Math.max(0, Math.trunc(typeof budget === 'number' ? budget : budget.resultLimit));
    const legacyTop = legacyIds.slice(0, topLimit);
    const adaptiveTop = adaptiveIds.slice(0, topLimit);
    const topIdsEqual = legacyTop.length === adaptiveTop.length
        && legacyTop.every((id, index) => id === adaptiveTop[index]);
    const adaptiveSet = new Set(adaptiveTop);
    const overlapCount = legacyTop.reduce((count, id) => count + (adaptiveSet.has(id) ? 1 : 0), 0);
    const legacyCandidateLimit = typeof budget === 'number'
        ? legacySearchCandidateLimit(topLimit)
        : budget.legacyCandidateLimit;
    const adaptiveCandidateLimit = typeof budget === 'number'
        ? adaptiveSearchCandidateLimit(topLimit)
        : budget.candidateLimit;
    return {
        legacyCandidateLimit,
        adaptiveCandidateLimit,
        legacyCount: legacyIds.length,
        adaptiveCount: adaptiveIds.length,
        topLimit,
        topIdsEqual,
        overlapCount,
    };
}
export const compareSearchCandidateBudget = compareSearchCandidateResults;
export const compareCandidateBudgetShadow = compareSearchCandidateResults;
//# sourceMappingURL=candidate-budget.js.map