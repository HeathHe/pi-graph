/**
 * Lock-guarded atomic file update — Protected Data Store write primitive.
 *
 * Synchronous by design so callers with sync public APIs (spec-writer) can
 * use it without signature changes. Self-contained: mirrors the O_EXCL
 * lock-file protocol of `src/graph/kg/sync/file-lock.ts` (which is async and
 * lives in the kg layer — importing it here would invert the dependency
 * direction).
 *
 * Guarantees:
 * - Cross-process exclusion via `<file>.lock` (O_EXCL create, stale reclaim).
 * - Read-modify-write is atomic as a whole: the callback reads current
 *   content INSIDE the lock, so concurrent updates never lose entries.
 * - The write goes to `<file>.tmp` then renames over the target. Windows
 *   rename-over-existing can throw EPERM transiently (AV / indexer holding
 *   the target) — retried with a tiny backoff.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, realpathSync, } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 60_000;
const RENAME_EPERM_RETRIES = 2;
/** Synchronous sleep without busy-waiting (no async allowed here). */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const heldLocks = new Map();
function readLockOwner(lockPath) {
    try {
        const value = JSON.parse(readFileSync(lockPath, 'utf8'));
        return Number.isInteger(value.pid) && (value.pid ?? 0) > 0
            && typeof value.token === 'string' && value.token.length > 0
            && typeof value.createdAt === 'number'
            ? value
            : null;
    }
    catch {
        return null;
    }
}
function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== 'ESRCH';
    }
}
function acquirePhysicalLockSync(lockPath) {
    const startedAt = Date.now();
    const token = randomUUID();
    mkdirSync(dirname(lockPath), { recursive: true });
    for (;;) {
        try {
            const fd = openSync(lockPath, 'wx');
            try {
                writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), 'utf-8');
            }
            finally {
                closeSync(fd);
            }
            return token;
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
        }
        try {
            const owner = readLockOwner(lockPath);
            const staleInvalid = !owner && Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
            const deadOwner = owner !== null && !processIsAlive(owner.pid);
            if (staleInvalid || deadOwner) {
                const verified = readLockOwner(lockPath);
                if ((owner === null && verified === null)
                    || (owner !== null && verified?.pid === owner.pid && verified.token === owner.token)) {
                    rmSync(lockPath, { force: true });
                    continue;
                }
            }
        }
        catch {
            // Lost the race with another process; retry until the bounded deadline.
        }
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
            throw new Error(`Timed out acquiring lock: ${lockPath}`);
        }
        sleepSync(LOCK_RETRY_MS);
    }
}
function retainLockSync(lockPath) {
    const held = heldLocks.get(lockPath);
    if (held) {
        held.count++;
        return;
    }
    heldLocks.set(lockPath, { token: acquirePhysicalLockSync(lockPath), count: 1 });
}
function releaseRetainedLockSync(lockPath) {
    const held = heldLocks.get(lockPath);
    if (!held)
        return;
    held.count--;
    if (held.count > 0)
        return;
    heldLocks.delete(lockPath);
    try {
        const owner = readLockOwner(lockPath);
        if (owner?.pid === process.pid && owner.token === held.token)
            unlinkSync(lockPath);
    }
    catch { /* a dead-owner reclaimer or cleanup already removed it */ }
}
function renameWithRetry(from, to) {
    for (let attempt = 0;; attempt++) {
        try {
            renameSync(from, to);
            return;
        }
        catch (err) {
            if (err.code !== 'EPERM' || attempt >= RENAME_EPERM_RETRIES) {
                throw err;
            }
            sleepSync(20 * (attempt + 1));
        }
    }
}
function canonicalExistingPath(path) {
    const abs = resolve(path);
    try {
        return realpathSync.native(abs);
    }
    catch {
        return abs;
    }
}
export function knowledgeCorpusNamespaceTarget(projectRoot) {
    return join(canonicalExistingPath(projectRoot), '.workflow', '.knowledge-corpus.namespace');
}
function corpusNamespaceTargetForFile(filePath) {
    const corpusDir = dirname(resolve(filePath));
    const workflowRoot = dirname(corpusDir);
    const corpusName = basename(corpusDir).toLowerCase();
    if ((corpusName !== 'specs' && corpusName !== 'knowhow')
        || basename(workflowRoot).toLowerCase() !== '.workflow')
        return null;
    return knowledgeCorpusNamespaceTarget(dirname(workflowRoot));
}
export function acquireFileLocksSync(filePaths) {
    const lockPaths = [...new Set(filePaths.map(filePath => `${resolve(filePath)}.lock`))].sort();
    const acquired = [];
    try {
        for (const lockPath of lockPaths) {
            retainLockSync(lockPath);
            acquired.push(lockPath);
        }
    }
    catch (error) {
        for (const lockPath of acquired.reverse())
            releaseRetainedLockSync(lockPath);
        throw error;
    }
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        for (const lockPath of acquired.reverse())
            releaseRetainedLockSync(lockPath);
    };
}
export function acquireKnowledgeCorpusNamespaceLockSync(projectRoot) {
    return acquireFileLocksSync([knowledgeCorpusNamespaceTarget(projectRoot)]);
}
/**
 * Read-modify-write `filePath` atomically under a cross-process lock.
 *
 * `update` receives the current content (`null` when the file does not
 * exist) and returns the full new content — or `null` to skip the write
 * (e.g. duplicate detected). Returns the callback's result.
 */
export function updateFileAtomic(filePath, update) {
    const namespaceTarget = corpusNamespaceTargetForFile(filePath);
    const release = acquireFileLocksSync([
        ...(namespaceTarget ? [namespaceTarget] : []),
        filePath,
    ]);
    try {
        const current = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
        const next = update(current);
        if (next === null || next === current)
            return next;
        const tmpPath = `${filePath}.tmp`;
        writeFileSync(tmpPath, next, 'utf-8');
        renameWithRetry(tmpPath, filePath);
        return next;
    }
    finally {
        release();
    }
}
//# sourceMappingURL=atomic-write.js.map