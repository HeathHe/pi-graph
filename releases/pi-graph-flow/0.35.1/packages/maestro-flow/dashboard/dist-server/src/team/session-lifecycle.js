/**
 * Pure team-session lifecycle classification and resume ranking.
 *
 * This module intentionally has no filesystem or clock dependencies. Callers
 * must supply both `now` and the stale TTL so classification is deterministic.
 */
export const TEAM_SESSION_LIFECYCLES = [
    'active',
    'paused',
    'completed',
    'failed',
    'abandoned',
    'archived',
];
export const TEAM_SESSION_HEALTHS = [
    'fresh',
    'idle',
    'stale_candidate',
    'inconsistent',
    'unknown',
];
const TERMINAL_LIFECYCLES = new Set([
    'completed',
    'failed',
    'abandoned',
    'archived',
]);
const RUN_LIFECYCLE = {
    created: 'active',
    running: 'active',
    blocked: 'paused',
    completed: 'completed',
    paused: 'paused',
    sealed: 'completed',
    archived: 'archived',
    failed: 'failed',
};
export function classifyTeamSession(evidence, options) {
    const now = parseRequiredClock(options.now, 'now');
    if (!Number.isFinite(options.staleTtlMs) || options.staleTtlMs < 0) {
        throw new TypeError('staleTtlMs must be a finite non-negative number');
    }
    const reasons = [];
    let inconsistent = false;
    const hasLiveMember = positiveCount(evidence.liveBrokerMembers);
    const hasNonTerminalTask = positiveCount(evidence.nonTerminalTasks);
    const live = hasLiveMember || hasNonTerminalTask;
    const livenessKnown = evidence.livenessKnown !== false && evidence.taskStateKnown !== false;
    if (positiveCount(evidence.persistedActiveWorkers) && !live) {
        reasons.push('persisted active workers are not live evidence');
    }
    const abandonmentAuditValid = validateAbandonmentAudit(evidence.abandonmentTransition, reasons);
    const sidecarLifecycle = acceptLifecycle(evidence.sidecarLifecycle, abandonmentAuditValid, 'sidecar', reasons);
    const metaLifecycle = acceptLifecycle(evidence.metaLifecycle, abandonmentAuditValid, 'meta', reasons);
    const runLifecycle = evidence.runStatus ? RUN_LIFECYCLE[evidence.runStatus] : undefined;
    let lifecycle;
    if (runLifecycle && TERMINAL_LIFECYCLES.has(runLifecycle)) {
        lifecycle = runLifecycle;
        if (sidecarLifecycle && !TERMINAL_LIFECYCLES.has(sidecarLifecycle)) {
            inconsistent = true;
            reasons.push(`terminal Run conflicts with ${sidecarLifecycle} sidecar`);
        }
    }
    else if (sidecarLifecycle) {
        lifecycle = sidecarLifecycle;
    }
    else if (metaLifecycle) {
        lifecycle = metaLifecycle;
    }
    else if (runLifecycle) {
        lifecycle = runLifecycle;
    }
    else {
        lifecycle = 'active';
        reasons.push('no canonical lifecycle evidence');
    }
    if (sidecarLifecycle && metaLifecycle && sidecarLifecycle !== metaLifecycle) {
        inconsistent = true;
        reasons.push(`sidecar lifecycle ${sidecarLifecycle} conflicts with meta lifecycle ${metaLifecycle}`);
    }
    if (runLifecycle &&
        TERMINAL_LIFECYCLES.has(runLifecycle) &&
        sidecarLifecycle &&
        TERMINAL_LIFECYCLES.has(sidecarLifecycle) &&
        runLifecycle !== sidecarLifecycle) {
        inconsistent = true;
        reasons.push(`Run lifecycle ${runLifecycle} conflicts with sidecar lifecycle ${sidecarLifecycle}`);
    }
    if (TERMINAL_LIFECYCLES.has(lifecycle) && live) {
        inconsistent = true;
        reasons.push('terminal lifecycle conflicts with live members or non-terminal tasks');
    }
    const activity = collectActivityTimestamp(evidence, reasons);
    const lastActivityAt = activity.lastActivityAt;
    let health;
    if (inconsistent) {
        health = 'inconsistent';
    }
    else if (live) {
        health = 'fresh';
        reasons.push(hasLiveMember ? 'live broker member present' : 'non-terminal task present');
    }
    else if (!livenessKnown) {
        health = 'unknown';
        reasons.push('broker or task liveness could not be verified');
    }
    else if (activity.invalid) {
        health = 'unknown';
    }
    else if (TERMINAL_LIFECYCLES.has(lifecycle)) {
        health = 'idle';
    }
    else if (lastActivityAt === undefined) {
        health = 'unknown';
        reasons.push('no valid activity timestamp');
    }
    else if (now - lastActivityAt > options.staleTtlMs) {
        health = 'stale_candidate';
        reasons.push('latest activity exceeds stale TTL');
    }
    else {
        health = 'fresh';
    }
    const cleanupEligible = TERMINAL_LIFECYCLES.has(lifecycle) &&
        health !== 'inconsistent' &&
        health !== 'unknown' &&
        !live;
    return {
        lifecycle,
        health,
        ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
        live,
        cleanupEligible,
        reasons,
    };
}
export function getTeamSessionCleanupEligibility(classification, _options = {}) {
    if (classification.health === 'stale_candidate') {
        return { eligible: false, reason: 'stale_candidate is derived health, not a cleanup lifecycle' };
    }
    if (classification.lifecycle === 'active' || classification.lifecycle === 'paused') {
        return { eligible: false, reason: `${classification.lifecycle} sessions are never cleanup eligible` };
    }
    if (classification.live) {
        return { eligible: false, reason: 'live members or non-terminal tasks block cleanup' };
    }
    if (classification.health === 'inconsistent' || classification.health === 'unknown') {
        return { eligible: false, reason: `${classification.health} evidence fails closed` };
    }
    return { eligible: classification.cleanupEligible, reason: 'terminal lifecycle is cleanup eligible' };
}
export function rankResumeCandidates(candidates, locator) {
    const hasLocator = Boolean(locator?.sessionId || locator?.runId || locator?.runDir);
    const ranked = candidates
        .map((candidate) => ({
        ...candidate,
        exactLocatorMatch: hasLocator && matchesLocator(candidate, locator),
        resumable: isResumeCandidate(candidate.classification),
        tied: false,
    }))
        .sort(compareResumeCandidates);
    markRankingTies(ranked);
    if (!hasLocator) {
        return {
            candidates: ranked,
            requiresUserSelection: ranked.some((candidate) => candidate.resumable),
            reason: 'manual_selection',
        };
    }
    const exactMatches = ranked.filter((candidate) => candidate.exactLocatorMatch);
    if (exactMatches.length === 0) {
        return { candidates: ranked, requiresUserSelection: true, reason: 'locator_not_found' };
    }
    if (exactMatches.length > 1) {
        return { candidates: ranked, requiresUserSelection: true, reason: 'locator_ambiguous' };
    }
    const exact = exactMatches[0];
    return {
        candidates: ranked,
        ...(exact.resumable ? { selected: exact } : {}),
        requiresUserSelection: !exact.resumable,
        reason: 'exact_locator',
    };
}
function parseRequiredClock(value, field) {
    const parsed = parseTimestamp(value);
    if (parsed === undefined) {
        throw new TypeError(`${field} must be a valid timestamp`);
    }
    return parsed;
}
function parseTimestamp(value) {
    if (value === null || value === undefined || value === '')
        return undefined;
    const parsed = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function positiveCount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function validateAbandonmentAudit(audit, reasons) {
    if (!audit)
        return false;
    const valid = audit.audited === true &&
        audit.actor.trim().length > 0 &&
        audit.reason.trim().length > 0 &&
        parseTimestamp(audit.at) !== undefined;
    if (!valid)
        reasons.push('invalid abandonment audit');
    return valid;
}
function acceptLifecycle(lifecycle, abandonmentAuditValid, source, reasons) {
    if (!lifecycle)
        return undefined;
    if (lifecycle === 'abandoned' && !abandonmentAuditValid) {
        reasons.push(`${source} abandoned lifecycle lacks an explicit audited transition`);
        return undefined;
    }
    return lifecycle;
}
function collectActivityTimestamp(evidence, reasons) {
    // Lower-priority clocks are fallbacks, not peers. In particular, touching a
    // legacy directory must not make an older durable message/task look fresh.
    const levels = [
        [
            ['latestMessageAt', evidence.latestMessageAt],
            ['latestTaskAt', evidence.latestTaskAt],
        ],
        [['metaUpdatedAt', evidence.metaUpdatedAt]],
        [['sidecarUpdatedAt', evidence.sidecarUpdatedAt]],
        [['filesystemMtime', evidence.filesystemMtime]],
    ];
    for (const level of levels) {
        const supplied = level.filter(([, value]) => value !== null && value !== undefined && value !== '');
        if (supplied.length === 0)
            continue;
        const timestamps = [];
        let invalid = false;
        for (const [field, value] of supplied) {
            const parsed = parseTimestamp(value);
            if (parsed === undefined) {
                reasons.push(`invalid ${field} timestamp`);
                invalid = true;
            }
            else {
                timestamps.push(parsed);
            }
        }
        return {
            ...(timestamps.length > 0 ? { lastActivityAt: Math.max(...timestamps) } : {}),
            invalid,
        };
    }
    return { invalid: false };
}
function matchesLocator(candidate, locator) {
    return ((locator.sessionId === undefined || candidate.sessionId === locator.sessionId) &&
        (locator.runId === undefined || candidate.runId === locator.runId) &&
        (locator.runDir === undefined || normalizeRunDir(candidate.runDir) === normalizeRunDir(locator.runDir)));
}
function normalizeRunDir(value) {
    return value?.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}
function isResumeCandidate(classification) {
    return classification.lifecycle === 'active' || classification.lifecycle === 'paused';
}
const HEALTH_RANK = {
    fresh: 5,
    idle: 4,
    stale_candidate: 3,
    unknown: 2,
    inconsistent: 1,
};
function compareResumeCandidates(a, b) {
    if (a.exactLocatorMatch !== b.exactLocatorMatch)
        return a.exactLocatorMatch ? -1 : 1;
    if (a.resumable !== b.resumable)
        return a.resumable ? -1 : 1;
    const healthDifference = HEALTH_RANK[b.classification.health] - HEALTH_RANK[a.classification.health];
    if (healthDifference !== 0)
        return healthDifference;
    const activityDifference = (b.classification.lastActivityAt ?? Number.NEGATIVE_INFINITY) -
        (a.classification.lastActivityAt ?? Number.NEGATIVE_INFINITY);
    if (activityDifference !== 0)
        return activityDifference;
    return stableCandidateKey(a).localeCompare(stableCandidateKey(b));
}
function markRankingTies(candidates) {
    for (let index = 0; index < candidates.length - 1; index += 1) {
        const current = candidates[index];
        const next = candidates[index + 1];
        if (current.exactLocatorMatch === next.exactLocatorMatch &&
            current.resumable === next.resumable &&
            current.classification.health === next.classification.health &&
            current.classification.lastActivityAt === next.classification.lastActivityAt) {
            current.tied = true;
            next.tied = true;
        }
    }
}
function stableCandidateKey(candidate) {
    return `${candidate.runId ?? ''}\u0000${candidate.sessionId}\u0000${normalizeRunDir(candidate.runDir) ?? ''}`;
}
//# sourceMappingURL=session-lifecycle.js.map