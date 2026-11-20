/**
 * Shared types and utilities for the search daemon (client + server).
 * Single source of truth — both daemon.ts and daemon-client.ts import from here.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { existsSync, readFileSync, realpathSync, unlinkSync, } from 'node:fs';
import { LOAD_SELECTION_TYPES } from './load-selection.js';
const DAEMON_FILE = 'search-daemon.json';
export const DAEMON_SPAWN_LOCK_FILE = 'search-daemon-spawning';
/** Protocol v2 is authenticated with the per-process descriptor instanceId. */
export const SEARCH_DAEMON_PROTOCOL = 'maestro-search-daemon/v2';
export const DAEMON_MAX_QUERY_CHARS = 4_096;
export const DAEMON_MAX_RESULTS = 500;
export const DAEMON_MAX_REQUEST_BYTES = 64 * 1024;
export const DAEMON_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Starting/draining health is observable but is never startup readiness. */
export function isDaemonReadyResponse(response) {
    return response?.ok === true && response.state === 'ready';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isBaseDaemonInfo(value) {
    if (!isRecord(value))
        return false;
    return Number.isSafeInteger(value.pid) && value.pid > 0
        && Number.isInteger(value.port) && value.port > 0 && value.port <= 65_535
        && typeof value.startedAt === 'string' && value.startedAt.length > 0;
}
function isInstanceId(value) {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
/** Resolve symlinks when possible and make Windows path comparisons stable. */
export function canonicalWorkflowRoot(workflowRoot) {
    let canonical;
    try {
        canonical = realpathSync.native(workflowRoot);
    }
    catch {
        canonical = resolve(workflowRoot);
    }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
export function isDaemonInfoV2(info, workflowRoot) {
    if (!isBaseDaemonInfo(info) || !isRecord(info))
        return false;
    if (info.protocol !== SEARCH_DAEMON_PROTOCOL
        || !isInstanceId(info.instanceId)
        || typeof info.workflowRoot !== 'string'
        || info.workflowRoot.length === 0
        || !isAbsolute(info.workflowRoot)
        || info.workflowRoot !== canonicalWorkflowRoot(info.workflowRoot)
        || !Number.isFinite(Date.parse(info.startedAt)))
        return false;
    return workflowRoot === undefined
        || info.workflowRoot === canonicalWorkflowRoot(workflowRoot);
}
export function getDaemonPath(workflowRoot) {
    return join(workflowRoot, DAEMON_FILE);
}
export function getDaemonSpawnLockPath(workflowRoot) {
    return join(workflowRoot, DAEMON_SPAWN_LOCK_FILE);
}
/**
 * Parse and validate both descriptor generations. Partially-v2 or malformed v2
 * data is rejected rather than silently downgraded to an unverified descriptor.
 */
export function readDaemonInfo(workflowRoot) {
    const path = getDaemonPath(workflowRoot);
    if (!existsSync(path))
        return null;
    try {
        const value = JSON.parse(readFileSync(path, 'utf-8'));
        if (!isBaseDaemonInfo(value) || !isRecord(value))
            return null;
        const hasV2Field = 'protocol' in value || 'instanceId' in value || 'workflowRoot' in value;
        if (hasV2Field && !isDaemonInfoV2(value))
            return null;
        return value;
    }
    catch {
        return null;
    }
}
/** PID existence is only a stale-file hint. It is never daemon authentication. */
export function isDaemonAlive(info) {
    if (!isBaseDaemonInfo(info))
        return false;
    try {
        process.kill(info.pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export function daemonIdentityRequest(info) {
    return {
        protocol: SEARCH_DAEMON_PROTOCOL,
        instanceId: info.instanceId,
        workflowRoot: info.workflowRoot,
    };
}
export function isResponseFromDaemon(info, response) {
    return response.protocol === SEARCH_DAEMON_PROTOCOL
        && response.instanceId === info.instanceId
        && response.workflowRoot === info.workflowRoot
        && response.pid === info.pid;
}
/** Remove a v2 descriptor only when the same instance still owns the path. */
export function deleteDaemonInfoIfOwned(workflowRoot, owner) {
    const current = readDaemonInfo(workflowRoot);
    if (!current || !isDaemonInfoV2(current, workflowRoot))
        return false;
    if (current.instanceId !== owner.instanceId || current.workflowRoot !== owner.workflowRoot)
        return false;
    try {
        unlinkSync(getDaemonPath(workflowRoot));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Reclaim a descriptor only after its recorded PID is dead and the descriptor
 * still matches the inspected value. This is used during startup, never stop.
 */
export function deleteDaemonInfoIfStale(workflowRoot, expected) {
    if (isDaemonAlive(expected))
        return false;
    const current = readDaemonInfo(workflowRoot);
    if (!current)
        return false;
    const sameBase = current.pid === expected.pid
        && current.port === expected.port
        && current.startedAt === expected.startedAt;
    const sameGeneration = isDaemonInfoV2(current) === isDaemonInfoV2(expected);
    const sameV2Owner = !isDaemonInfoV2(current) || !isDaemonInfoV2(expected)
        || (current.instanceId === expected.instanceId && current.workflowRoot === expected.workflowRoot);
    if (!sameBase || !sameGeneration || !sameV2Owner)
        return false;
    try {
        unlinkSync(getDaemonPath(workflowRoot));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Drop a dead-pid descriptor for this workflow so a successor can spawn.
 * Live, foreign, and malformed descriptors are left in place.
 * Legacy files in this directory are reclaimed when their PID is dead;
 * the path itself is the workspace identity for that generation.
 */
export function reclaimDeadDaemonDescriptor(workflowRoot) {
    const path = getDaemonPath(workflowRoot);
    if (!existsSync(path))
        return true;
    const existing = readDaemonInfo(workflowRoot);
    if (!existing)
        return false;
    if (isDaemonInfoV2(existing) && !isDaemonInfoV2(existing, workflowRoot))
        return false;
    if (isDaemonAlive(existing))
        return false;
    if (deleteDaemonInfoIfStale(workflowRoot, existing))
        return true;
    const current = readDaemonInfo(workflowRoot);
    if (current && isDaemonInfoV2(current, workflowRoot) && !isDaemonAlive(current)) {
        return deleteDaemonInfoIfOwned(workflowRoot, current);
    }
    return !existsSync(path);
}
/** Release a spawn lock only when the caller still owns its opaque token. */
export function releaseDaemonSpawnLock(workflowRoot, token) {
    if (!token)
        return false;
    const path = getDaemonSpawnLockPath(workflowRoot);
    try {
        if (readFileSync(path, 'utf-8') !== token)
            return false;
        unlinkSync(path);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Once a v2 descriptor is atomically owned, it safely supersedes every spawn
 * arbitration artifact: all other contenders must observe the live descriptor
 * before spawning or fail their own descriptor `wx` claim.
 */
export function deleteDaemonSpawnLocksIfOwned(workflowRoot, owner) {
    const current = readDaemonInfo(workflowRoot);
    if (!current || !isDaemonInfoV2(current, workflowRoot))
        return false;
    if (current.instanceId !== owner.instanceId || current.workflowRoot !== owner.workflowRoot)
        return false;
    let removed = false;
    for (const path of [getDaemonSpawnLockPath(workflowRoot), `${getDaemonSpawnLockPath(workflowRoot)}.reclaim`]) {
        try {
            unlinkSync(path);
            removed = true;
        }
        catch { /* already absent or concurrently owner-cleaned */ }
    }
    return removed;
}
function validateIdentityFields(value, required) {
    const present = value.protocol !== undefined || value.instanceId !== undefined || value.workflowRoot !== undefined;
    if (!required && !present)
        return null;
    if (value.protocol !== SEARCH_DAEMON_PROTOCOL)
        return 'invalid daemon protocol';
    if (!isInstanceId(value.instanceId))
        return 'invalid daemon instanceId';
    if (typeof value.workflowRoot !== 'string' || value.workflowRoot.length === 0 || value.workflowRoot.length > 32_768) {
        return 'invalid daemon workflowRoot';
    }
    return null;
}
function validateDiagnostics(value) {
    if (value === undefined || value === false)
        return null;
    if (value === true)
        return null;
    if (!isRecord(value))
        return 'diagnostics must be a boolean or object';
    for (const key of Object.keys(value)) {
        if (key !== 'requestId')
            return `unknown diagnostics field: ${key}`;
    }
    if (value.requestId !== undefined && !isInstanceId(value.requestId)) {
        return 'diagnostics.requestId must be a UUID';
    }
    return null;
}
function validateCandidateBudget(value) {
    if (value === undefined)
        return null;
    if (!isRecord(value))
        return 'candidateBudget must be an object';
    const allowed = new Set([
        'resultLimit', 'limit', 'candidateLimit', 'initialCandidateLimit',
        'maxCandidateLimit', 'hardCap', 'mode', 'adaptive', 'escalated',
        'escalationCount', 'legacyCandidateLimit', 'surface',
    ]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            return `unknown candidateBudget field: ${key}`;
    }
    if (value.mode !== 'legacy' && value.mode !== 'adaptive')
        return 'candidateBudget.mode is invalid';
    if (typeof value.adaptive !== 'boolean' || value.adaptive !== (value.mode === 'adaptive')) {
        return 'candidateBudget.adaptive is invalid';
    }
    const integerFields = [
        'resultLimit', 'limit', 'candidateLimit', 'initialCandidateLimit',
        'maxCandidateLimit', 'hardCap', 'escalationCount', 'legacyCandidateLimit',
    ];
    for (const field of integerFields) {
        if (!Number.isSafeInteger(value[field]))
            return `candidateBudget.${field} must be an integer`;
        if (value[field] < 0 || value[field] > DAEMON_MAX_RESULTS) {
            return `candidateBudget.${field} is out of bounds`;
        }
    }
    const maxCandidateLimit = value.maxCandidateLimit;
    const hardCap = value.hardCap;
    const candidateLimit = value.candidateLimit;
    const initialCandidateLimit = value.initialCandidateLimit;
    const escalationCount = value.escalationCount;
    if (maxCandidateLimit !== hardCap || hardCap === 0) {
        return 'candidateBudget cap is inconsistent';
    }
    if (candidateLimit > maxCandidateLimit || initialCandidateLimit > maxCandidateLimit) {
        return 'candidateBudget candidateLimit exceeds hard cap';
    }
    if (typeof value.escalated !== 'boolean' || escalationCount > 1) {
        return 'candidateBudget escalation is invalid';
    }
    if (typeof value.surface !== 'string' || ![
        'search', 'wiki', 'mixed', 'indexer', 'planned', 'kg', 'code', 'arch-kb',
    ].includes(value.surface))
        return 'candidateBudget.surface is invalid';
    return null;
}
function validateFilters(value) {
    if (value === undefined)
        return null;
    if (!isRecord(value))
        return 'filters must be an object';
    const allowed = new Set([
        'type', 'category', 'tag', 'keyword', 'workspace',
        'repoId', 'repoAlias', 'applicableRepoId', 'includeDeprecated',
    ]);
    for (const [key, field] of Object.entries(value)) {
        if (!allowed.has(key))
            return `unknown filter: ${key}`;
        if (key === 'includeDeprecated') {
            if (typeof field !== 'boolean')
                return 'filters.includeDeprecated must be a boolean';
        }
        else if (typeof field !== 'string' || field.length > DAEMON_MAX_QUERY_CHARS) {
            return `filters.${key} must be a bounded string`;
        }
    }
    return null;
}
function validateLoadSelection(value) {
    if (value === undefined)
        return null;
    if (!isRecord(value))
        return 'selection must be an object';
    const allowed = new Set([
        'type', 'ids', 'category', 'keyword', 'tag', 'includeDeprecated', 'limit',
        'projection', 'applicableRepoId', 'targetRepoId', 'targetAlias', 'originExplicit',
    ]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            return `unknown selection field: ${key}`;
    }
    if (typeof value.type !== 'string' || !LOAD_SELECTION_TYPES.includes(value.type)) {
        return 'selection.type is invalid';
    }
    if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > DAEMON_MAX_RESULTS) {
        return `selection.limit must be an integer between 1 and ${DAEMON_MAX_RESULTS}`;
    }
    if (value.projection !== 'full' && value.projection !== 'metadata')
        return 'selection.projection is invalid';
    if (value.ids !== undefined) {
        if (!Array.isArray(value.ids) || value.ids.length > DAEMON_MAX_RESULTS
            || value.ids.some(id => typeof id !== 'string' || id.length === 0 || id.length > DAEMON_MAX_QUERY_CHARS)) {
            return 'selection.ids must be an array of bounded non-empty strings';
        }
    }
    for (const key of ['category', 'keyword', 'tag', 'applicableRepoId', 'targetRepoId', 'targetAlias']) {
        const field = value[key];
        if (field !== undefined && (typeof field !== 'string' || field.length === 0 || field.length > DAEMON_MAX_QUERY_CHARS)) {
            return `selection.${key} must be a bounded non-empty string`;
        }
    }
    for (const key of ['includeDeprecated', 'originExplicit']) {
        if (value[key] !== undefined && typeof value[key] !== 'boolean')
            return `selection.${key} must be a boolean`;
    }
    if (value.targetRepoId !== undefined && value.targetAlias !== undefined) {
        return 'selection repository target is ambiguous';
    }
    if (value.originExplicit === true && value.targetRepoId === undefined && value.targetAlias === undefined) {
        return 'selection explicit repository target is missing';
    }
    return null;
}
/** Strict protocol boundary validation before any indexer work is started. */
export function validateDaemonRequest(value) {
    if (!isRecord(value) || typeof value.action !== 'string') {
        return { ok: false, error: 'request must be an object with an action' };
    }
    const action = value.action;
    if (!['search', 'load', 'invalidate', 'ping', 'health', 'shutdown'].includes(action)) {
        return { ok: false, error: 'unknown action' };
    }
    const identityError = validateIdentityFields(value, action === 'load' || action === 'ping' || action === 'health' || action === 'shutdown');
    if (identityError)
        return { ok: false, error: identityError };
    const commonKeys = new Set(['action', 'protocol', 'instanceId', 'workflowRoot']);
    if (action === 'search') {
        if (typeof value.query !== 'string' || value.query.trim().length === 0) {
            return { ok: false, error: 'query must be a non-empty string' };
        }
        if (value.query.length > DAEMON_MAX_QUERY_CHARS) {
            return { ok: false, error: `query exceeds ${DAEMON_MAX_QUERY_CHARS} characters` };
        }
        if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > DAEMON_MAX_RESULTS) {
            return { ok: false, error: `limit must be an integer between 1 and ${DAEMON_MAX_RESULTS}` };
        }
        if (value.skipEmbedding !== undefined && typeof value.skipEmbedding !== 'boolean') {
            return { ok: false, error: 'skipEmbedding must be a boolean' };
        }
        const filtersError = validateFilters(value.filters);
        if (filtersError)
            return { ok: false, error: filtersError };
        const candidateBudgetError = validateCandidateBudget(value.candidateBudget);
        if (candidateBudgetError)
            return { ok: false, error: candidateBudgetError };
        const diagnosticsError = validateDiagnostics(value.diagnostics);
        if (diagnosticsError)
            return { ok: false, error: diagnosticsError };
        for (const key of Object.keys(value)) {
            if (!commonKeys.has(key) && !['query', 'limit', 'skipEmbedding', 'filters', 'candidateBudget', 'diagnostics'].includes(key)) {
                return { ok: false, error: `unknown request field: ${key}` };
            }
        }
    }
    else if (action === 'load') {
        const selectionError = validateLoadSelection(value.selection);
        if (selectionError)
            return { ok: false, error: selectionError };
        for (const key of Object.keys(value)) {
            if (!commonKeys.has(key) && key !== 'selection')
                return { ok: false, error: `unknown request field: ${key}` };
        }
    }
    else {
        for (const key of Object.keys(value)) {
            if (!commonKeys.has(key))
                return { ok: false, error: `unknown request field: ${key}` };
        }
    }
    return { ok: true, request: value };
}
//# sourceMappingURL=daemon-types.js.map