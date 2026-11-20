import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, utimesSync, writeFileSync, } from 'node:fs';
import { join, resolve } from 'node:path';
export const KG_SYNC_WORKER_MARKER_SCHEMA_VERSION = 'kg-sync-worker-marker/1.0';
export const KG_SYNC_WORKER_MARKER_RELATIVE_PATH = '.workflow/kg-sync-worker.pid';
export const DEFAULT_KG_SYNC_WORKER_STALE_MS = 5 * 60_000;
export const KG_SYNC_WORKER_MARKER_MAX_BYTES = 4 * 1024;
const KG_SYNC_WORKER_MAX_FUTURE_SKEW_MS = 60_000;
const INVALID_MARKER_GRACE_MS = 5_000;
const MUTATION_GUARD_WAIT_MS = 2_000;
const MUTATION_GUARD_INITIALIZATION_GRACE_MS = 100;
const MUTATION_GUARD_OWNER_MAX_BYTES = 1_024;
const MUTATION_GUARD_NAME = '.kg-sync-worker-mutation.lock';
const MUTATION_GUARD_OWNER_NAME = 'owner.json';
/** A guard older than this can only belong to a crashed holder: the protected
 *  marker mutation completes in well under a second. */
const MUTATION_GUARD_STALE_MS = DEFAULT_KG_SYNC_WORKER_STALE_MS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class UnsafeKgSyncWorkerMarkerError extends Error {
    code = 'KG_SYNC_WORKER_UNSAFE_PATH';
    path;
    constructor(path, detail) {
        super(`Unsafe KG sync worker marker path ${path}: ${detail}`);
        this.name = 'UnsafeKgSyncWorkerMarkerError';
        this.path = path;
    }
}
export class KgSyncWorkerMutationBusyError extends Error {
    code = 'KG_SYNC_WORKER_MUTATION_BUSY';
    path;
    constructor(path) {
        super(`Timed out acquiring KG sync worker mutation guard: ${path}`);
        this.name = 'KgSyncWorkerMutationBusyError';
        this.path = path;
    }
}
const heartbeatTimers = new Map();
export function kgSyncWorkerMarkerPath(projectRoot) {
    let root = resolve(projectRoot);
    try {
        root = realpathSync(root);
    }
    catch { /* display-only path may not exist yet */ }
    return resolve(root, ...KG_SYNC_WORKER_MARKER_RELATIVE_PATH.split('/'));
}
/**
 * PID remains line one so the installed 0.5.63 `parseInt(...trim(), 10)` reader
 * sees a versioned marker as its original live-worker wire format.
 */
export function serializeKgSyncWorkerMarker(pid, token, startedAt, mode) {
    assertPositivePid(pid);
    if (!UUID_PATTERN.test(token))
        throw new Error('KG sync worker marker token must be a lowercase UUID');
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
        throw new Error('KG sync worker marker started_at must be a non-negative integer');
    }
    if (mode !== 'worker' && mode !== 'maintenance') {
        throw new Error('KG sync worker marker mode must be worker or maintenance');
    }
    const record = {
        schema_version: KG_SYNC_WORKER_MARKER_SCHEMA_VERSION,
        pid,
        token,
        started_at: startedAt,
        mode,
    };
    return `${pid}\n${JSON.stringify(record)}\n`;
}
/** Accepts only legacy decimal bytes or the exact versioned two-line record. */
export function parseKgSyncWorkerMarker(raw) {
    if (/^[1-9][0-9]*\n?$/.test(raw)) {
        const pid = Number(raw.trim());
        if (!Number.isSafeInteger(pid))
            return null;
        return { pid, token: null, started_at: null, mode: 'worker', legacy: true };
    }
    const match = raw.match(/^([1-9][0-9]*)\n([^\n]+)\n$/);
    if (!match)
        return null;
    const linePid = Number(match[1]);
    if (!Number.isSafeInteger(linePid))
        return null;
    let value;
    try {
        value = JSON.parse(match[2]);
    }
    catch {
        return null;
    }
    if (!isRecord(value))
        return null;
    const expectedKeys = ['schema_version', 'pid', 'token', 'started_at', 'mode'];
    const keys = Object.keys(value);
    if (keys.length !== expectedKeys.length
        || keys.some((key, index) => key !== expectedKeys[index]))
        return null;
    if (value.schema_version !== KG_SYNC_WORKER_MARKER_SCHEMA_VERSION
        || value.pid !== linePid
        || !Number.isSafeInteger(value.pid)
        || typeof value.token !== 'string'
        || !UUID_PATTERN.test(value.token)
        || !Number.isSafeInteger(value.started_at)
        || value.started_at < 0
        || (value.mode !== 'worker' && value.mode !== 'maintenance'))
        return null;
    return {
        schema_version: KG_SYNC_WORKER_MARKER_SCHEMA_VERSION,
        pid: value.pid,
        token: value.token,
        started_at: value.started_at,
        mode: value.mode,
        legacy: false,
    };
}
export function inspectKgSyncWorkerMarker(projectRoot, options = {}) {
    const displayPath = kgSyncWorkerMarkerPath(projectRoot);
    const now = options.now ?? Date.now();
    const isPidLive = options.isPidLive ?? defaultIsPidLive;
    let paths;
    try {
        paths = resolveSafeWorkerMarkerPaths(projectRoot, false);
    }
    catch (error) {
        if (!(error instanceof UnsafeKgSyncWorkerMarkerError))
            throw error;
        return {
            exists: true,
            live: false,
            owner: null,
            foreignPid: null,
            ageMs: Number.MAX_SAFE_INTEGER,
            path: displayPath,
            invalidReason: 'unsafe-parent',
        };
    }
    if (paths.parent === null) {
        return missingInspection(paths.markerPath);
    }
    assertStableWorkerMarkerParent(paths);
    return inspectionFromWorkerMarkerRead(paths.markerPath, readWorkerMarkerFile(paths.markerPath), now, isPidLive);
}
/** Exclusive marker creation is serialized with reclaim and release. */
export function acquireKgSyncWorkerToken(projectRoot, mode, options = {}) {
    const pid = options.pid ?? process.pid;
    const token = options.token ?? randomUUID();
    const now = options.now ?? Date.now();
    const staleMs = options.staleMs ?? DEFAULT_KG_SYNC_WORKER_STALE_MS;
    const isPidLive = options.isPidLive ?? defaultIsPidLive;
    assertPositivePid(pid);
    if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error('KG sync worker marker acquisition time must be a non-negative integer');
    }
    if (!Number.isFinite(staleMs) || staleMs < 0) {
        throw new Error('KG sync worker marker staleMs must be a non-negative finite number');
    }
    const resolved = resolveSafeWorkerMarkerPaths(projectRoot, true);
    if (resolved.parent === null) {
        throw new UnsafeKgSyncWorkerMarkerError(resolved.workflowPath, 'marker parent is missing');
    }
    const result = withWorkerMarkerMutationGuard(resolved, (guard) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            assertStableWorkerMarkerParent(resolved);
            const read = readWorkerMarkerFile(resolved.markerPath);
            const inspection = inspectionFromWorkerMarkerRead(resolved.markerPath, read, now, isPidLive);
            if (!inspection.exists) {
                const created = createWorkerMarkerFile(resolved, pid, token, now, mode, staleMs);
                if (created)
                    return { acquired: true, token: created };
                continue;
            }
            assertMarkerMutationSafe(resolved.markerPath, read);
            if (!isReclaimableInspection(inspection, staleMs)) {
                return {
                    acquired: false,
                    reason: 'already-running',
                    ownerMode: inspection.owner?.mode ?? 'foreign',
                    ownerPid: inspection.owner?.pid ?? inspection.foreignPid,
                    legacy: inspection.owner?.legacy ?? false,
                };
            }
            if (read.status === 'missing' || read.stat === null) {
                throw new UnsafeKgSyncWorkerMarkerError(resolved.markerPath, 'marker generation is unavailable');
            }
            assertMutationGuardOwnership(guard);
            unlinkWorkerMarkerGeneration(resolved, read.stat);
        }
        throw new UnsafeKgSyncWorkerMarkerError(resolved.markerPath, 'marker changed repeatedly during acquisition');
    });
    if (result.acquired)
        scheduleHeartbeat(result.token);
    return result;
}
/** Refreshes the finite lease without changing the marker generation. */
export function refreshKgSyncWorkerToken(token, now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0)
        return false;
    try {
        const resolved = resolveSafeWorkerMarkerPaths(token.projectRoot, false);
        if (resolved.parent === null || resolved.markerPath !== token.path)
            return false;
        return withWorkerMarkerMutationGuard(resolved, () => {
            assertStableWorkerMarkerParent(resolved);
            const read = readWorkerMarkerFile(resolved.markerPath);
            if (read.status !== 'read' || !matchesTokenGeneration(token, read.stat))
                return false;
            const owner = parseKgSyncWorkerMarker(read.raw);
            if (!owner || owner.legacy || owner.pid !== token.pid || owner.token !== token.token)
                return false;
            const heartbeat = new Date(now);
            utimesSync(resolved.markerPath, heartbeat, heartbeat);
            const after = lstatSync(resolved.markerPath);
            return after.isFile() && matchesTokenGeneration(token, after);
        });
    }
    catch {
        return false;
    }
}
/** Removes only the same versioned token and filesystem generation acquired. */
export function releaseKgSyncWorkerToken(token) {
    clearHeartbeat(token);
    try {
        const resolved = resolveSafeWorkerMarkerPaths(token.projectRoot, false);
        if (resolved.parent === null || resolved.markerPath !== token.path)
            return false;
        return withWorkerMarkerMutationGuard(resolved, (guard) => {
            assertStableWorkerMarkerParent(resolved);
            const read = readWorkerMarkerFile(resolved.markerPath);
            if (read.status !== 'read' || !matchesTokenGeneration(token, read.stat))
                return false;
            const owner = parseKgSyncWorkerMarker(read.raw);
            if (!owner || owner.legacy || owner.pid !== token.pid || owner.token !== token.token)
                return false;
            assertMutationGuardOwnership(guard);
            unlinkWorkerMarkerGeneration(resolved, read.stat);
            return true;
        });
    }
    catch {
        return false;
    }
}
/** Reconstructs ownership in the detached worker after its parent wrote bytes. */
export function adoptKgSyncWorkerToken(projectRoot, pid, token) {
    try {
        const resolved = resolveSafeWorkerMarkerPaths(projectRoot, false);
        if (resolved.parent === null)
            return null;
        const read = readWorkerMarkerFile(resolved.markerPath);
        if (read.status !== 'read')
            return null;
        const owner = parseKgSyncWorkerMarker(read.raw);
        if (!owner || owner.legacy || owner.pid !== pid || owner.token !== token)
            return null;
        const now = Date.now();
        if (owner.started_at > now + KG_SYNC_WORKER_MAX_FUTURE_SKEW_MS
            || markerAgeMs(now, read.stat.mtimeMs) >= DEFAULT_KG_SYNC_WORKER_STALE_MS)
            return null;
        assertStableWorkerMarkerParent(resolved);
        const adopted = {
            projectRoot: resolved.canonicalRoot,
            path: resolved.markerPath,
            pid,
            token,
            startedAt: owner.started_at,
            mode: owner.mode,
            inode: read.stat.ino,
            generation: fileGeneration(read.stat),
            leaseMs: DEFAULT_KG_SYNC_WORKER_STALE_MS,
        };
        scheduleHeartbeat(adopted);
        return adopted;
    }
    catch {
        return null;
    }
}
export async function waitForKgSyncWorkerQuiescence(projectRoot, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const inspection = inspectKgSyncWorkerMarker(projectRoot);
        if (!inspection.exists || !inspection.live)
            return;
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for KG sync ${inspection.owner?.mode ?? 'foreign'} owner PID ${inspection.owner?.pid ?? inspection.foreignPid ?? 'unknown'}`);
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
}
export async function withKgSyncMaintenanceToken(projectRoot, fn) {
    const acquired = acquireKgSyncWorkerToken(projectRoot, 'maintenance');
    if (!acquired.acquired) {
        throw new Error(`KG sync ${acquired.ownerMode} owner is already running`);
    }
    try {
        return await fn();
    }
    finally {
        releaseKgSyncWorkerToken(acquired.token);
    }
}
function resolveSafeWorkerMarkerPaths(projectRoot, createParent) {
    let canonicalRoot;
    try {
        canonicalRoot = realpathSync(resolve(projectRoot));
    }
    catch {
        throw new UnsafeKgSyncWorkerMarkerError(resolve(projectRoot), 'project root is missing');
    }
    const rootStat = lstatSync(canonicalRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new UnsafeKgSyncWorkerMarkerError(canonicalRoot, 'project root is not a real directory');
    }
    const workflowPath = join(canonicalRoot, '.workflow');
    const markerPath = join(workflowPath, 'kg-sync-worker.pid');
    const guardPath = join(workflowPath, MUTATION_GUARD_NAME);
    let parent;
    try {
        parent = lstatSync(workflowPath);
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            throw new UnsafeKgSyncWorkerMarkerError(workflowPath, 'marker parent cannot be inspected');
        }
        if (!createParent) {
            return { canonicalRoot, workflowPath, markerPath, guardPath, parent: null };
        }
        try {
            mkdirSync(workflowPath, { mode: 0o700 });
        }
        catch (mkdirError) {
            if (mkdirError.code !== 'EEXIST')
                throw mkdirError;
        }
        parent = lstatSync(workflowPath);
    }
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
        throw new UnsafeKgSyncWorkerMarkerError(workflowPath, 'marker parent must be a real directory');
    }
    let canonicalParent;
    try {
        canonicalParent = realpathSync(workflowPath);
    }
    catch {
        throw new UnsafeKgSyncWorkerMarkerError(workflowPath, 'marker parent cannot be resolved');
    }
    if (comparablePath(canonicalParent) !== comparablePath(workflowPath)) {
        throw new UnsafeKgSyncWorkerMarkerError(workflowPath, 'marker parent escapes through a symlink');
    }
    return { canonicalRoot, workflowPath, markerPath, guardPath, parent };
}
function assertStableWorkerMarkerParent(paths) {
    let current;
    let canonicalParent;
    try {
        current = lstatSync(paths.workflowPath);
        canonicalParent = realpathSync(paths.workflowPath);
    }
    catch {
        throw new UnsafeKgSyncWorkerMarkerError(paths.workflowPath, 'marker parent changed');
    }
    if (current.isSymbolicLink()
        || !current.isDirectory()
        || !sameFilesystemEntry(paths.parent, current)
        || comparablePath(canonicalParent) !== comparablePath(paths.workflowPath)) {
        throw new UnsafeKgSyncWorkerMarkerError(paths.workflowPath, 'marker parent changed or escaped');
    }
}
function withWorkerMarkerMutationGuard(paths, fn) {
    const guard = acquireMutationGuard(paths);
    let result;
    let primaryError;
    try {
        result = fn(guard);
    }
    catch (error) {
        primaryError = error;
    }
    let releaseError;
    try {
        releaseMutationGuard(paths, guard);
    }
    catch (error) {
        releaseError = error;
    }
    if (primaryError !== undefined && releaseError !== undefined) {
        throw new AggregateError([primaryError, releaseError], 'KG sync worker mutation and guard release both failed');
    }
    if (primaryError !== undefined)
        throw primaryError;
    if (releaseError !== undefined)
        throw releaseError;
    return result;
}
function acquireMutationGuard(paths) {
    const deadline = Date.now() + MUTATION_GUARD_WAIT_MS;
    let initializingSince = null;
    for (;;) {
        assertStableWorkerMarkerParent(paths);
        const token = randomUUID();
        try {
            mkdirSync(paths.guardPath, { mode: 0o700 });
            const directory = lstatSync(paths.guardPath);
            if (directory.isSymbolicLink() || !directory.isDirectory()) {
                throw new UnsafeKgSyncWorkerMarkerError(paths.guardPath, 'guard is not a real directory');
            }
            const ownerPath = join(paths.guardPath, MUTATION_GUARD_OWNER_NAME);
            writeFileSync(ownerPath, JSON.stringify({
                schema_version: 'kg-sync-worker-mutation-guard/1.0',
                pid: process.pid,
                token,
                created_at: Date.now(),
            }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            assertStableWorkerMarkerParent(paths);
            return { path: paths.guardPath, ownerPath, token, directory };
        }
        catch (error) {
            if (error.code !== 'EEXIST') {
                cleanupPartialMutationGuard(paths.guardPath, token);
                throw error;
            }
        }
        const state = inspectMutationGuard(paths.guardPath);
        const now = Date.now();
        if (state === 'initializing') {
            initializingSince ??= now;
            if (now - initializingSince >= MUTATION_GUARD_INITIALIZATION_GRACE_MS) {
                throw new UnsafeKgSyncWorkerMarkerError(paths.guardPath, 'mutation guard is malformed or requires manual cleanup');
            }
        }
        else {
            initializingSince = null;
            if (state === 'unsafe') {
                throw new UnsafeKgSyncWorkerMarkerError(paths.guardPath, 'mutation guard is malformed or requires manual cleanup');
            }
        }
        if (reclaimStaleMutationGuard(paths.guardPath, now)) {
            continue;
        }
        if (now >= deadline)
            throw new KgSyncWorkerMutationBusyError(paths.guardPath);
        sleepSync(10);
    }
}
/**
 * Reclaims a guard whose owner record is intact but older than the lease.
 * PID liveness is intentionally not consulted: a reused PID would look alive
 * and deadlock the guard forever — the same finite-lease rationale as
 * isReclaimableInspection. Future timestamps (negative age) never reclaim.
 * Returns true only when both entries were removed; on any race the caller
 * simply re-enters the wait loop.
 *
 * 回收协议（认领→复核→删除）：先把 guard 目录 rename 到唯一认领名——
 * rename 是原子操作，只有一个回收者能成功，且此后原路径立即可被他人重建。
 * 随后复核认领目录里的 owner 与先前观测到的过期代际一致才删除；
 * 不一致说明原持有者已收尾、该路径被重建过，把目录放回原位（失败则由
 * assertMutationGuardOwnership 的 fencing 兜底，绝不误删新一代）。
 */
function reclaimStaleMutationGuard(path, now) {
    const ownerPath = join(path, MUTATION_GUARD_OWNER_NAME);
    let owner = null;
    try {
        owner = parseMutationGuardOwner(readBoundedRegularFile(ownerPath, MUTATION_GUARD_OWNER_MAX_BYTES).raw);
    }
    catch {
        return false; // Unreadable owners take the 'unsafe' path — never reclaim.
    }
    if (!owner)
        return false;
    if (!(now - owner.created_at >= MUTATION_GUARD_STALE_MS))
        return false;
    const claimPath = `${path}.reclaim-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
        renameSync(path, claimPath);
    }
    catch {
        return false; // 已被其他回收者认领,或原持有者已收尾删除
    }
    try {
        const claimed = parseMutationGuardOwner(readBoundedRegularFile(join(claimPath, MUTATION_GUARD_OWNER_NAME), MUTATION_GUARD_OWNER_MAX_BYTES).raw);
        if (!claimed || claimed.token !== owner.token || claimed.created_at !== owner.created_at) {
            // 代际已变:放回原位;原位被占则留给 fencing 兜底
            try {
                renameSync(claimPath, path);
            }
            catch { /* 新一代已在原位 */ }
            return false;
        }
        rmSync(claimPath, { recursive: true, force: true });
        return true;
    }
    catch {
        // 复核读取失败:目录身份不明,放回原位保守处理
        try {
            renameSync(claimPath, path);
        }
        catch { /* 新一代已在原位 */ }
        return false;
    }
}
/**
 * Fencing check before a destructive protected write: the guard may have
 * been reclaimed and recreated while this holder was suspended mid-section,
 * so ownership is re-verified between marker validation and the mutation
 * itself. The remaining check-then-act window is two adjacent syscalls,
 * which the filesystem cannot narrow further. Creation needs no fence (wx
 * is atomic) and refresh is already fenced by the stricter marker owner
 * comparison — unlink is the only destructive write.
 */
function assertMutationGuardOwnership(guard) {
    try {
        const current = lstatSync(guard.path);
        if (!sameFilesystemEntry(guard.directory, current) || !current.isDirectory()) {
            throw new Error('guard generation changed');
        }
        const owner = parseMutationGuardOwner(readBoundedRegularFile(guard.ownerPath, MUTATION_GUARD_OWNER_MAX_BYTES).raw);
        if (!owner || owner.token !== guard.token || owner.pid !== process.pid) {
            throw new Error('guard owner changed');
        }
    }
    catch (error) {
        if (error instanceof UnsafeKgSyncWorkerMarkerError)
            throw error;
        throw new UnsafeKgSyncWorkerMarkerError(guard.path, 'mutation guard ownership lost before protected write');
    }
}
function releaseMutationGuard(paths, guard) {
    assertStableWorkerMarkerParent(paths);
    const currentDirectory = lstatSync(guard.path);
    if (!sameFilesystemEntry(guard.directory, currentDirectory) || !currentDirectory.isDirectory()) {
        throw new UnsafeKgSyncWorkerMarkerError(guard.path, 'mutation guard generation changed');
    }
    const owner = parseMutationGuardOwner(readBoundedRegularFile(guard.ownerPath, MUTATION_GUARD_OWNER_MAX_BYTES).raw);
    if (!owner || owner.token !== guard.token || owner.pid !== process.pid) {
        throw new UnsafeKgSyncWorkerMarkerError(guard.path, 'mutation guard owner changed');
    }
    unlinkSync(guard.ownerPath);
    rmdirSync(guard.path);
    assertStableWorkerMarkerParent(paths);
}
function inspectMutationGuard(path) {
    let stat;
    try {
        stat = lstatSync(path);
    }
    catch {
        return 'unsafe';
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
        return 'unsafe';
    try {
        const owner = parseMutationGuardOwner(readBoundedRegularFile(join(path, MUTATION_GUARD_OWNER_NAME), MUTATION_GUARD_OWNER_MAX_BYTES).raw);
        // A present but unparseable owner is genuinely malformed; a missing one
        // is transient (mid-creation or mid-reclaim).
        return owner ? 'busy' : 'unsafe';
    }
    catch (error) {
        // mkdir and owner.json creation cannot be atomic. A contender may observe
        // the directory in that tiny window; retry it briefly without treating a
        // persistently ownerless or malformed guard as reclaimable.
        return error.code === 'ENOENT' ? 'initializing' : 'unsafe';
    }
}
function parseMutationGuardOwner(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!isRecord(value))
        return null;
    if (value.schema_version !== 'kg-sync-worker-mutation-guard/1.0'
        || !Number.isSafeInteger(value.pid)
        || value.pid <= 0
        || typeof value.token !== 'string'
        || !UUID_PATTERN.test(value.token)
        || !Number.isSafeInteger(value.created_at)
        || value.created_at < 0)
        return null;
    return {
        pid: value.pid,
        token: value.token,
        created_at: value.created_at,
    };
}
function cleanupPartialMutationGuard(path, token) {
    try {
        const ownerPath = join(path, MUTATION_GUARD_OWNER_NAME);
        const owner = parseMutationGuardOwner(readBoundedRegularFile(ownerPath, MUTATION_GUARD_OWNER_MAX_BYTES).raw);
        if (owner?.token !== token || owner.pid !== process.pid)
            return;
        unlinkSync(ownerPath);
        rmdirSync(path);
    }
    catch {
        // A partial or foreign guard remains visible for manual recovery.
    }
}
function createWorkerMarkerFile(paths, pid, token, now, mode, leaseMs) {
    assertStableWorkerMarkerParent(paths);
    let descriptor = null;
    let created = null;
    try {
        descriptor = openSync(paths.markerPath, 'wx', 0o600);
        writeFileSync(descriptor, serializeKgSyncWorkerMarker(pid, token, now, mode), 'utf8');
        created = fstatSync(descriptor);
        if (!created.isFile() || created.size > KG_SYNC_WORKER_MARKER_MAX_BYTES) {
            throw new UnsafeKgSyncWorkerMarkerError(paths.markerPath, 'creation produced an unsafe file');
        }
        closeSync(descriptor);
        descriptor = null;
        assertStableWorkerMarkerParent(paths);
        const atPath = lstatSync(paths.markerPath);
        if (atPath.isSymbolicLink() || !sameStableFile(created, atPath)) {
            throw new UnsafeKgSyncWorkerMarkerError(paths.markerPath, 'marker changed during creation');
        }
        return {
            projectRoot: paths.canonicalRoot,
            path: paths.markerPath,
            pid,
            token,
            startedAt: now,
            mode,
            inode: atPath.ino,
            generation: fileGeneration(atPath),
            leaseMs,
        };
    }
    catch (error) {
        if (descriptor !== null) {
            try {
                created = fstatSync(descriptor);
            }
            catch { /* preserve primary error */ }
            try {
                closeSync(descriptor);
            }
            catch { /* descriptor already closed */ }
        }
        if (error.code === 'EEXIST')
            return null;
        if (created) {
            try {
                unlinkWorkerMarkerGeneration(paths, created);
            }
            catch { /* preserve primary error */ }
        }
        throw error;
    }
}
function readWorkerMarkerFile(path) {
    let before;
    try {
        before = lstatSync(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { status: 'missing' };
        return { status: 'unsafe', stat: null, reason: 'read-failed' };
    }
    if (before.isSymbolicLink())
        return { status: 'unsafe', stat: before, reason: 'symlink' };
    if (!before.isFile())
        return { status: 'unsafe', stat: before, reason: 'not-regular' };
    if (before.size > KG_SYNC_WORKER_MARKER_MAX_BYTES) {
        return { status: 'unsafe', stat: before, reason: 'too-large' };
    }
    try {
        const stable = readBoundedRegularFile(path, KG_SYNC_WORKER_MARKER_MAX_BYTES, before);
        return {
            status: 'read',
            raw: stable.raw,
            stat: stable.stat,
        };
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { status: 'missing' };
        return { status: 'unsafe', stat: before, reason: 'changed' };
    }
}
function readBoundedRegularFile(path, maxBytes, expected) {
    const before = expected ?? lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
        throw new Error('Unsafe bounded file');
    }
    let descriptor = null;
    try {
        descriptor = openSync(path, safeReadFlags());
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || !sameFileIdentity(before, opened)) {
            throw new Error('Bounded file changed before open');
        }
        const buffer = Buffer.allocUnsafe(maxBytes + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
            if (bytesRead === 0)
                break;
            offset += bytesRead;
        }
        if (offset > maxBytes)
            throw new Error('Bounded file is too large');
        const afterRead = fstatSync(descriptor);
        const afterPath = lstatSync(path);
        if (!sameStableFile(opened, afterRead) || !sameStableFile(afterRead, afterPath)) {
            throw new Error('Bounded file changed while reading');
        }
        return {
            raw: buffer.subarray(0, offset).toString('utf8'),
            stat: afterRead,
        };
    }
    finally {
        if (descriptor !== null) {
            try {
                closeSync(descriptor);
            }
            catch { /* descriptor already closed */ }
        }
    }
}
function inspectionFromWorkerMarkerRead(path, read, now, isPidLive) {
    if (read.status === 'missing')
        return missingInspection(path);
    if (read.status === 'unsafe') {
        return {
            exists: true,
            live: false,
            owner: null,
            foreignPid: null,
            ageMs: markerAgeMs(now, read.stat?.mtimeMs),
            path,
            invalidReason: read.reason,
        };
    }
    const owner = parseKgSyncWorkerMarker(read.raw);
    if (!owner)
        return invalidParsedInspection(path, read.raw, read.stat, now, isPidLive, 'malformed');
    if (read.stat.mtimeMs > now + KG_SYNC_WORKER_MAX_FUTURE_SKEW_MS) {
        return invalidParsedInspection(path, read.raw, read.stat, now, isPidLive, 'future-mtime');
    }
    if (!owner.legacy && owner.started_at > now + KG_SYNC_WORKER_MAX_FUTURE_SKEW_MS) {
        return invalidParsedInspection(path, read.raw, read.stat, now, isPidLive, 'future-timestamp');
    }
    const ageMs = markerAgeMs(now, read.stat.mtimeMs);
    return {
        exists: true,
        live: ageMs < DEFAULT_KG_SYNC_WORKER_STALE_MS && isPidLive(owner.pid),
        owner,
        foreignPid: null,
        ageMs,
        path,
        invalidReason: null,
    };
}
function missingInspection(path) {
    return {
        exists: false,
        live: false,
        owner: null,
        foreignPid: null,
        ageMs: 0,
        path,
        invalidReason: null,
    };
}
function invalidParsedInspection(path, raw, stat, now, isPidLive, invalidReason) {
    const pid = firstLinePid(raw);
    return {
        exists: true,
        live: false,
        owner: null,
        foreignPid: pid !== null && isPidLive(pid) ? pid : null,
        ageMs: markerAgeMs(now, stat.mtimeMs),
        path,
        invalidReason,
    };
}
function assertMarkerMutationSafe(path, read) {
    if (read.status !== 'unsafe' || read.reason === 'too-large')
        return;
    throw new UnsafeKgSyncWorkerMarkerError(path, `marker is ${read.reason}`);
}
function unlinkWorkerMarkerGeneration(paths, expected) {
    assertStableWorkerMarkerParent(paths);
    const current = lstatSync(paths.markerPath);
    if (current.isSymbolicLink() || !current.isFile() || !sameFileIdentity(expected, current)) {
        throw new UnsafeKgSyncWorkerMarkerError(paths.markerPath, 'marker generation changed');
    }
    unlinkSync(paths.markerPath);
    assertStableWorkerMarkerParent(paths);
}
function isReclaimableInspection(inspection, staleMs) {
    if (inspection.invalidReason != null) {
        return inspection.ageMs >= Math.min(staleMs, INVALID_MARKER_GRACE_MS);
    }
    // Ownership is a finite lease. A reused or unrelated live PID cannot renew it.
    return inspection.ageMs >= staleMs;
}
function scheduleHeartbeat(token) {
    clearHeartbeat(token);
    const leaseMs = token.leaseMs ?? DEFAULT_KG_SYNC_WORKER_STALE_MS;
    if (leaseMs <= 0)
        return;
    const intervalMs = Math.max(25, Math.min(Math.floor(leaseMs / 3), 30_000));
    const timer = setInterval(() => {
        if (!refreshKgSyncWorkerToken(token))
            clearHeartbeat(token);
    }, intervalMs);
    timer.unref?.();
    heartbeatTimers.set(heartbeatKey(token), timer);
}
function clearHeartbeat(token) {
    const key = heartbeatKey(token);
    const timer = heartbeatTimers.get(key);
    if (timer)
        clearInterval(timer);
    heartbeatTimers.delete(key);
}
function heartbeatKey(token) {
    return `${token.path}\0${token.token}`;
}
function matchesTokenGeneration(token, stat) {
    const generation = token.generation;
    return stat.isFile()
        && stat.ino === token.inode
        && (generation === undefined
            || (stat.dev === generation.device && stat.ino === generation.inode));
}
function fileGeneration(stat) {
    return { device: stat.dev, inode: stat.ino };
}
function markerAgeMs(now, timestamp) {
    if (timestamp === undefined
        || !Number.isFinite(timestamp)
        || timestamp < 0
        || timestamp > now + KG_SYNC_WORKER_MAX_FUTURE_SKEW_MS)
        return Number.MAX_SAFE_INTEGER;
    return Math.max(0, now - timestamp);
}
function safeReadFlags() {
    return constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0);
}
function sameFileIdentity(left, right) {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.isFile() === right.isFile();
}
function sameFilesystemEntry(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}
function sameStableFile(left, right) {
    return sameFileIdentity(left, right)
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}
function comparablePath(path) {
    const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function firstLinePid(raw) {
    const first = raw.match(/^([1-9][0-9]*)(?:\n|$)/)?.[1];
    if (!first)
        return null;
    const pid = Number(first);
    return Number.isSafeInteger(pid) ? pid : null;
}
function defaultIsPidLive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
function assertPositivePid(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error('KG sync worker marker PID must be a positive integer');
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=kg-sync-worker-state.js.map