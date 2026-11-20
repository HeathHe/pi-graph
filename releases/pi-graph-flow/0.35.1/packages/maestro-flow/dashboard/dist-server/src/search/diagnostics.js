import { randomUUID } from 'node:crypto';
/** Stable schema identifier for request-scoped search diagnostics. */
export const SEARCH_DIAGNOSTICS_SCHEMA = 'maestro-search-diagnostics/1.0';
/** Diagnostics are deliberately small: they are for attribution, not tracing. */
export const SEARCH_DIAGNOSTICS_MAX_BYTES = 16 * 1024;
export const SEARCH_DIAGNOSTICS_MAX_PHASES = 32;
export const SEARCH_DIAGNOSTICS_MAX_FALLBACKS = 16;
export const SEARCH_DIAGNOSTICS_MAX_TOKEN_LENGTH = 64;
function boundedDuration(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return 0;
    return Math.min(2_147_483_647, Math.max(0, Math.round(value)));
}
function boundedCount(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return 0;
    return Math.min(1_000_000_000, Math.max(0, Math.trunc(value)));
}
/** Keep diagnostics tokens opaque and path-free. */
function boundedToken(value, fallback = 'unknown') {
    if (typeof value !== 'string')
        return fallback;
    const token = value.trim().toLowerCase();
    if (!token || token.length > SEARCH_DIAGNOSTICS_MAX_TOKEN_LENGTH)
        return fallback;
    // Slashes, dots, whitespace, and punctuation are intentionally rejected so
    // a path or an arbitrary error/query string cannot cross this boundary.
    return /^[a-z0-9][a-z0-9_-]*$/.test(token) ? token : fallback;
}
function validRequestId(value) {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function provider(value) {
    return value === 'daemon' || value === 'indexer' || value === 'mixed'
        || value === 'kg' || value === 'arch-kb' || value === 'none'
        ? value
        : undefined;
}
function cacheState(value) {
    return value === 'hit' || value === 'miss' || value === 'stale' || value === 'unknown'
        ? value
        : undefined;
}
function normalizeCandidateBudget(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const row = value;
    const mode = row.mode === 'legacy' || row.mode === 'adaptive' ? row.mode : null;
    if (!mode)
        return null;
    const requestedLimit = boundedCount(row.requestedLimit);
    const initialCandidateLimit = boundedCount(row.initialCandidateLimit);
    const candidateLimit = boundedCount(row.candidateLimit);
    const hardCap = boundedCount(row.hardCap);
    const legacyCandidateLimit = boundedCount(row.legacyCandidateLimit);
    if (hardCap <= 0 || candidateLimit > hardCap || initialCandidateLimit > hardCap)
        return null;
    return {
        mode,
        requestedLimit,
        initialCandidateLimit,
        candidateLimit,
        hardCap,
        escalated: row.escalated === true,
        legacyCandidateLimit,
    };
}
function normalizePhase(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const row = value;
    const phase = boundedToken(row.phase);
    if (phase === 'unknown')
        return null;
    const normalized = { phase, durationMs: boundedDuration(row.durationMs) };
    if (row.candidateCount !== undefined)
        normalized.candidateCount = boundedCount(row.candidateCount);
    return normalized;
}
function normalizeFallback(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const row = value;
    const source = boundedToken(row.source);
    const reason = boundedToken(row.reason);
    if (source === 'unknown' || reason === 'unknown')
        return null;
    return { source, reason };
}
/**
 * Validate and sanitize diagnostics crossing a daemon/CLI boundary. Unknown
 * fields are ignored so a newer daemon can safely answer an older client.
 */
export function sanitizeSearchDiagnostics(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const row = value;
    if (row.schemaVersion !== SEARCH_DIAGNOSTICS_SCHEMA || !validRequestId(row.requestId))
        return null;
    const phases = [];
    if (Array.isArray(row.phases)) {
        for (const item of row.phases.slice(0, SEARCH_DIAGNOSTICS_MAX_PHASES)) {
            const phase = normalizePhase(item);
            if (phase)
                phases.push(phase);
        }
    }
    const fallbacks = [];
    if (Array.isArray(row.fallbacks)) {
        for (const item of row.fallbacks.slice(0, SEARCH_DIAGNOSTICS_MAX_FALLBACKS)) {
            const fallback = normalizeFallback(item);
            if (fallback)
                fallbacks.push(fallback);
        }
    }
    const normalized = {
        schemaVersion: SEARCH_DIAGNOSTICS_SCHEMA,
        requestId: row.requestId,
        durationMs: boundedDuration(row.durationMs),
        phases,
        fallbacks,
    };
    const normalizedProvider = provider(row.provider);
    if (normalizedProvider)
        normalized.provider = normalizedProvider;
    const normalizedCache = cacheState(row.cacheState);
    if (normalizedCache)
        normalized.cacheState = normalizedCache;
    if (typeof row.embeddingUsed === 'boolean')
        normalized.embeddingUsed = row.embeddingUsed;
    if (row.embeddingDocs !== undefined)
        normalized.embeddingDocs = boundedCount(row.embeddingDocs);
    if (row.resultCount !== undefined)
        normalized.resultCount = boundedCount(row.resultCount);
    if (row.candidateCount !== undefined)
        normalized.candidateCount = boundedCount(row.candidateCount);
    if (row.eligibleCandidateCount !== undefined) {
        normalized.eligibleCandidateCount = boundedCount(row.eligibleCandidateCount);
    }
    const normalizedBudget = normalizeCandidateBudget(row.candidateBudget);
    if (normalizedBudget)
        normalized.candidateBudget = normalizedBudget;
    if (typeof row.truncated === 'boolean')
        normalized.truncated = row.truncated;
    return normalized;
}
/** Runtime type guard for compatible daemon responses. */
export function isSearchDiagnostics(value) {
    return sanitizeSearchDiagnostics(value) !== null;
}
/** Naming aliases for protocol/client callers that use normalize terminology. */
export const normalizeSearchDiagnostics = sanitizeSearchDiagnostics;
export const createSearchDiagnosticsContext = createSearchDiagnostics;
function baseSnapshot(requestId) {
    return {
        schemaVersion: SEARCH_DIAGNOSTICS_SCHEMA,
        requestId,
        durationMs: 0,
        phases: [],
        fallbacks: [],
    };
}
/** Create an in-memory, bounded recorder for exactly one search request. */
export function createSearchDiagnostics(options) {
    const requestId = validRequestId(options?.requestId) ? options.requestId : randomUUID();
    const startedAt = performance.now();
    let state = baseSnapshot(requestId);
    let finalized = false;
    const recorder = {
        requestId,
        recordPhase(phaseName, durationMs, candidateCount) {
            if (state.phases.length >= SEARCH_DIAGNOSTICS_MAX_PHASES) {
                state.truncated = true;
                return;
            }
            const phase = boundedToken(phaseName);
            if (phase === 'unknown') {
                state.truncated = true;
                return;
            }
            state.phases.push({
                phase,
                durationMs: boundedDuration(durationMs),
                ...(candidateCount === undefined ? {} : { candidateCount: boundedCount(candidateCount) }),
            });
        },
        phase(phaseName, durationMs, candidateCount) {
            recorder.recordPhase(phaseName, durationMs, candidateCount);
        },
        recordFallback(sourceName, reasonName) {
            if (state.fallbacks.length >= SEARCH_DIAGNOSTICS_MAX_FALLBACKS) {
                state.truncated = true;
                return;
            }
            const source = boundedToken(sourceName);
            const reason = boundedToken(reasonName);
            if (source === 'unknown' || reason === 'unknown') {
                state.truncated = true;
                return;
            }
            state.fallbacks.push({ source, reason });
        },
        fallback(sourceName, reasonName) {
            recorder.recordFallback(sourceName, reasonName);
        },
        setProvider(value) {
            state.provider = value;
        },
        setCacheState(value) {
            // Preserve the strongest observed state when concurrent index/cache work
            // reports more than one phase (stale > miss > hit > unknown).
            const rank = {
                unknown: 0, hit: 1, miss: 2, stale: 3,
            };
            if (!state.cacheState || rank[value] >= rank[state.cacheState])
                state.cacheState = value;
        },
        setEmbedding(used, docs) {
            state.embeddingUsed = used;
            state.embeddingDocs = boundedCount(docs);
        },
        setResultCount(count) {
            state.resultCount = boundedCount(count);
        },
        setCandidateCount(count) {
            state.candidateCount = boundedCount(count);
        },
        setEligibleCandidateCount(count) {
            state.eligibleCandidateCount = boundedCount(count);
        },
        setCandidateBudget(budget) {
            const normalized = normalizeCandidateBudget(budget);
            if (normalized)
                state.candidateBudget = normalized;
        },
        merge(value) {
            const remote = sanitizeSearchDiagnostics(value);
            if (!remote)
                return;
            for (const phase of remote.phases)
                recorder.recordPhase(phase.phase, phase.durationMs, phase.candidateCount);
            for (const fallback of remote.fallbacks)
                recorder.recordFallback(fallback.source, fallback.reason);
            if (remote.provider)
                recorder.setProvider(remote.provider);
            if (remote.cacheState)
                recorder.setCacheState(remote.cacheState);
            if (remote.embeddingUsed !== undefined)
                recorder.setEmbedding(remote.embeddingUsed, remote.embeddingDocs ?? 0);
            if (remote.resultCount !== undefined)
                recorder.setResultCount(remote.resultCount);
            if (remote.candidateCount !== undefined)
                recorder.setCandidateCount(remote.candidateCount);
            if (remote.eligibleCandidateCount !== undefined)
                recorder.setEligibleCandidateCount?.(remote.eligibleCandidateCount);
            if (remote.candidateBudget)
                recorder.setCandidateBudget?.(remote.candidateBudget);
            if (remote.truncated)
                state.truncated = true;
        },
        snapshot() {
            // The duration is calculated on every read, keeping the context useful
            // even when a caller asks for diagnostics after a partially failed path.
            state.durationMs = finalized
                ? state.durationMs
                : boundedDuration(performance.now() - startedAt);
            return {
                ...state,
                phases: state.phases.map(phase => ({ ...phase })),
                fallbacks: state.fallbacks.map(fallback => ({ ...fallback })),
            };
        },
        toJSON() {
            return recorder.snapshot();
        },
        finish() {
            if (!finalized) {
                state.durationMs = boundedDuration(performance.now() - startedAt);
                finalized = true;
            }
            return recorder.snapshot();
        },
    };
    return recorder;
}
/** Finish a recorder when the caller wants an explicit terminal snapshot. */
export function finishSearchDiagnostics(recorder) {
    const finish = recorder.finish;
    return typeof finish === 'function' ? finish() : recorder.snapshot();
}
/** Record an async phase while preserving the original result/error. */
export async function withSearchDiagnosticPhase(recorder, phase, work, candidateCount) {
    if (!recorder)
        return typeof work === 'function' ? work() : work;
    const startedAt = performance.now();
    try {
        return await (typeof work === 'function' ? work() : work);
    }
    finally {
        recorder.recordPhase(phase, performance.now() - startedAt, candidateCount);
    }
}
/** Record a synchronous phase without leaking its return value into the API. */
export function recordSearchDiagnosticPhase(recorder, phase, work, candidateCount) {
    if (!recorder)
        return work();
    const startedAt = performance.now();
    try {
        return work();
    }
    finally {
        recorder.recordPhase(phase, performance.now() - startedAt, candidateCount);
    }
}
/**
 * Return a sanitized object suitable for embedding in a larger JSON response.
 * The result is guaranteed to stay under the diagnostics byte budget; optional
 * fields and then tail phases/fallbacks are removed if a custom token somehow
 * causes the budget to be exceeded.
 */
export function boundedSearchDiagnostics(value) {
    const normalized = sanitizeSearchDiagnostics(value);
    if (!normalized)
        return null;
    const fits = (candidate) => Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= SEARCH_DIAGNOSTICS_MAX_BYTES;
    if (fits(normalized))
        return normalized;
    const compact = {
        schemaVersion: normalized.schemaVersion,
        requestId: normalized.requestId,
        durationMs: normalized.durationMs,
        phases: normalized.phases.slice(0, 8),
        fallbacks: normalized.fallbacks.slice(0, 8),
        truncated: true,
    };
    if (normalized.provider)
        compact.provider = normalized.provider;
    if (normalized.cacheState)
        compact.cacheState = normalized.cacheState;
    if (normalized.embeddingUsed !== undefined)
        compact.embeddingUsed = normalized.embeddingUsed;
    if (normalized.embeddingDocs !== undefined)
        compact.embeddingDocs = normalized.embeddingDocs;
    if (normalized.resultCount !== undefined)
        compact.resultCount = normalized.resultCount;
    if (normalized.candidateCount !== undefined)
        compact.candidateCount = normalized.candidateCount;
    if (normalized.eligibleCandidateCount !== undefined)
        compact.eligibleCandidateCount = normalized.eligibleCandidateCount;
    if (normalized.candidateBudget)
        compact.candidateBudget = normalized.candidateBudget;
    while (!fits(compact) && compact.fallbacks.length > 0)
        compact.fallbacks.pop();
    while (!fits(compact) && compact.phases.length > 0)
        compact.phases.pop();
    return compact;
}
/** Serialize a bounded diagnostics object for stderr or protocol tests. */
export function serializeSearchDiagnostics(value) {
    const normalized = boundedSearchDiagnostics(value) ?? boundedSearchDiagnostics(baseSnapshot(randomUUID()));
    return JSON.stringify(normalized);
}
//# sourceMappingURL=diagnostics.js.map