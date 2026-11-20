import { relative } from 'node:path';
import { watch } from 'chokidar';
import { watchDisabledReason } from './watch-policy.js';
const SOURCE_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.vue', '.py', '.go', '.java', '.rs',
]);
const ALWAYS_IGNORE = ['.workflow', '.git', 'node_modules', 'dist', '.codegraph'];
export class LockUnavailableError extends Error {
    constructor(message = 'File lock unavailable; another process is writing') {
        super(message);
        this.name = 'LockUnavailableError';
    }
}
export class FileWatcher {
    watcher = null;
    debounceTimer = null;
    pendingFiles = new Map();
    syncStartedMs = 0;
    syncing = false;
    stopped = false;
    chokidarReady = false;
    projectRoot;
    debounceMs;
    syncFn;
    onSyncComplete;
    onSyncError;
    constructor(projectRoot, syncFn, options = {}) {
        this.projectRoot = projectRoot;
        this.syncFn = syncFn;
        this.debounceMs = options.debounceMs ?? 2000;
        this.onSyncComplete = options.onSyncComplete;
        this.onSyncError = options.onSyncError;
    }
    start() {
        if (this.watcher)
            return true;
        this.stopped = false;
        const disabledReason = watchDisabledReason(this.projectRoot);
        if (disabledReason)
            return false;
        try {
            this.watcher = watch(this.projectRoot, {
                ignored: (testPath) => this.shouldIgnore(testPath),
                ignoreInitial: true,
                persistent: true,
            });
            this.watcher.on('ready', () => {
                this.chokidarReady = true;
                this.pendingFiles.clear();
            });
            this.watcher.on('all', (_event, filePath) => {
                if (this.stopped)
                    return;
                const normalized = relative(this.projectRoot, filePath).replace(/\\/g, '/');
                if (!this.isSourceFile(normalized))
                    return;
                if (this.chokidarReady) {
                    const now = Date.now();
                    const existing = this.pendingFiles.get(normalized);
                    this.pendingFiles.set(normalized, {
                        firstSeenMs: existing?.firstSeenMs ?? now,
                        lastSeenMs: now,
                    });
                }
                this.scheduleSync();
            });
            this.watcher.on('error', () => { });
            return true;
        }
        catch {
            return false;
        }
    }
    stop() {
        this.stopped = true;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        this.pendingFiles.clear();
        this.chokidarReady = false;
    }
    isActive() {
        return this.watcher !== null && !this.stopped;
    }
    getPendingFiles() {
        const result = [];
        for (const [filePath, info] of this.pendingFiles) {
            result.push({
                path: filePath,
                firstSeenMs: info.firstSeenMs,
                lastSeenMs: info.lastSeenMs,
                indexing: this.syncing && this.syncStartedMs >= info.lastSeenMs,
            });
        }
        return result;
    }
    shouldIgnore(testPath) {
        const rel = relative(this.projectRoot, testPath).replace(/\\/g, '/');
        if (!rel || rel === '.' || rel.startsWith('..'))
            return false;
        for (const ignored of ALWAYS_IGNORE) {
            if (rel === ignored || rel.startsWith(ignored + '/'))
                return true;
        }
        return false;
    }
    isSourceFile(relPath) {
        const dotIdx = relPath.lastIndexOf('.');
        if (dotIdx === -1)
            return false;
        return SOURCE_EXTS.has(relPath.slice(dotIdx));
    }
    scheduleSync() {
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.flush();
        }, this.debounceMs);
    }
    async flush() {
        if (this.syncing || this.stopped)
            return;
        this.syncStartedMs = Date.now();
        this.syncing = true;
        try {
            const result = await this.syncFn();
            for (const [filePath, info] of this.pendingFiles) {
                if (info.lastSeenMs <= this.syncStartedMs)
                    this.pendingFiles.delete(filePath);
            }
            this.onSyncComplete?.(result);
        }
        catch (err) {
            if (!(err instanceof LockUnavailableError)) {
                const error = err instanceof Error ? err : new Error(String(err));
                this.onSyncError?.(error);
            }
        }
        finally {
            this.syncing = false;
            if (this.pendingFiles.size > 0 && !this.stopped)
                this.scheduleSync();
        }
    }
}
//# sourceMappingURL=watcher.js.map