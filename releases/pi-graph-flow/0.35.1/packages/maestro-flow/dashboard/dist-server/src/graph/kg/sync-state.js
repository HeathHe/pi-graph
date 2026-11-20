/**
 * KG Sync State — persistent freshness watermark for codegraph sync.
 *
 * Records the git HEAD at the last successful codegraph sync in
 * .workflow/kg/sync-state.json so change detection can catch committed
 * changes (commit / pull / branch switch) that leave the working tree clean.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export const KG_SYNC_STATE_SCHEMA_VERSION = 'kg-sync-state/2.0';
export function getSyncStatePath(projectPath) {
    return resolve(projectPath, '.workflow', 'kg', 'sync-state.json');
}
export function readSyncState(projectPath) {
    try {
        const data = JSON.parse(readFileSync(getSyncStatePath(projectPath), 'utf-8'));
        if (data.schema_version === KG_SYNC_STATE_SCHEMA_VERSION) {
            const persisted = parsePersistedV2(data);
            if (!persisted)
                return null;
            const lastSyncHead = persisted.lastSuccessful?.head ?? null;
            const lastSyncAt = persisted.lastSuccessful?.completedAt ?? 0;
            return {
                ...persisted,
                lastSyncHead,
                lastSyncAt,
                requiresRefresh: false,
            };
        }
        // Read legacy v1 state without changing it on disk.
        if (!Number.isFinite(data.lastSyncAt))
            return null;
        const legacyHead = typeof data.lastSyncHead === 'string' || data.lastSyncHead === null
            ? data.lastSyncHead
            : null;
        return {
            schema_version: KG_SYNC_STATE_SCHEMA_VERSION,
            lastSyncHead: legacyHead,
            lastSyncAt: data.lastSyncAt,
            lastSuccessful: {
                head: legacyHead,
                manifestDigest: null,
                externalFingerprint: '',
                startedAt: data.lastSyncAt,
                completedAt: data.lastSyncAt,
            },
            lastAttempt: null,
            requiresRefresh: true,
        };
    }
    catch {
        return null;
    }
}
export function writeSyncState(projectPath, head, manifestDigest = null, externalFingerprint = '', options = {}) {
    const startedAt = options.startedAt ?? Date.now();
    const previous = readSyncState(projectPath);
    const failedAttempt = {
        status: 'failed',
        startedAt,
        finishedAt: Date.now(),
        error: 'sync watermark commit did not complete',
    };
    // Persist a stale/error sentinel first. If the success write fails after the
    // graph COMMIT, health remains visible and lastSuccessful never advances.
    writeStateDocument(projectPath, {
        schema_version: KG_SYNC_STATE_SCHEMA_VERSION,
        lastSuccessful: previous?.lastSuccessful ?? null,
        lastAttempt: failedAttempt,
    });
    try {
        options.beforeSuccessWrite?.();
    }
    catch (error) {
        writeStateDocument(projectPath, {
            schema_version: KG_SYNC_STATE_SCHEMA_VERSION,
            lastSuccessful: previous?.lastSuccessful ?? null,
            lastAttempt: {
                status: 'failed',
                startedAt,
                finishedAt: Date.now(),
                error: error instanceof Error ? error.message : String(error),
            },
        });
        throw error;
    }
    const completedAt = Date.now();
    const successful = {
        head,
        manifestDigest,
        externalFingerprint,
        startedAt,
        completedAt,
    };
    writeStateDocument(projectPath, {
        schema_version: KG_SYNC_STATE_SCHEMA_VERSION,
        lastSuccessful: successful,
        lastAttempt: {
            status: 'succeeded',
            startedAt,
            finishedAt: completedAt,
            error: null,
        },
    });
}
/** Records a failed attempt without advancing the last successful watermark. */
export function writeSyncStateFailure(projectPath, startedAt, error) {
    const previous = readSyncState(projectPath);
    writeStateDocument(projectPath, {
        schema_version: KG_SYNC_STATE_SCHEMA_VERSION,
        lastSuccessful: previous?.lastSuccessful ?? null,
        lastAttempt: {
            status: 'failed',
            startedAt,
            finishedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
        },
    });
}
export function getSyncStateHealth(projectPath) {
    const state = readSyncState(projectPath);
    if (!state) {
        return existsSync(getSyncStatePath(projectPath))
            ? {
                status: 'error',
                stale: true,
                error: 'sync state is malformed or unreadable',
                state: null,
            }
            : { status: 'missing', stale: true, error: null, state: null };
    }
    if (state.requiresRefresh)
        return { status: 'stale', stale: true, error: null, state };
    if (state.lastAttempt?.status === 'failed') {
        return {
            status: 'error',
            stale: true,
            error: state.lastAttempt.error ?? 'sync watermark write failed',
            state,
        };
    }
    if (!state.lastSuccessful)
        return { status: 'stale', stale: true, error: null, state };
    return { status: 'fresh', stale: false, error: null, state };
}
/** A v2 watermark is fresh only when every authoritative input still matches. */
export function isSyncStateFresh(state, snapshot) {
    if (!state || state.requiresRefresh || state.lastAttempt?.status === 'failed')
        return false;
    const successful = state.lastSuccessful;
    return successful !== null
        && successful.head === snapshot.head
        && successful.manifestDigest === snapshot.manifestDigest
        && successful.externalFingerprint === snapshot.externalFingerprint;
}
function writeStateDocument(projectPath, data) {
    const path = getSyncStatePath(projectPath);
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    try {
        writeFileSync(tempPath, JSON.stringify(data), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
        renameSync(tempPath, path);
    }
    catch (error) {
        try {
            unlinkSync(tempPath);
        }
        catch { /* temp may not exist */ }
        throw error;
    }
}
function parsePersistedV2(data) {
    const successful = data.lastSuccessful;
    const attempt = data.lastAttempt;
    if (successful !== null && !isWatermark(successful))
        return null;
    if (attempt !== null && !isAttempt(attempt))
        return null;
    return {
        schema_version: KG_SYNC_STATE_SCHEMA_VERSION,
        lastSuccessful: successful,
        lastAttempt: attempt,
    };
}
function isWatermark(value) {
    if (!isRecord(value))
        return false;
    return (typeof value.head === 'string' || value.head === null)
        && (typeof value.manifestDigest === 'string' || value.manifestDigest === null)
        && typeof value.externalFingerprint === 'string'
        && Number.isFinite(value.startedAt)
        && Number.isFinite(value.completedAt);
}
function isAttempt(value) {
    if (!isRecord(value))
        return false;
    return (value.status === 'succeeded' || value.status === 'failed')
        && Number.isFinite(value.startedAt)
        && Number.isFinite(value.finishedAt)
        && (typeof value.error === 'string' || value.error === null);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function getGitHead(projectPath) {
    try {
        const head = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: projectPath,
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        }).trim();
        return head || null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=sync-state.js.map