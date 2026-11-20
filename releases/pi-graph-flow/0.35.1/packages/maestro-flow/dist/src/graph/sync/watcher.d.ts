export interface WatchOptions {
    debounceMs?: number;
    onSyncComplete?: (result: {
        filesChanged: number;
        durationMs: number;
    }) => void;
    onSyncError?: (error: Error) => void;
}
export interface PendingFile {
    path: string;
    firstSeenMs: number;
    lastSeenMs: number;
    indexing: boolean;
}
export declare class LockUnavailableError extends Error {
    constructor(message?: string);
}
export declare class FileWatcher {
    private watcher;
    private debounceTimer;
    private pendingFiles;
    private syncStartedMs;
    private syncing;
    private stopped;
    private chokidarReady;
    private readonly projectRoot;
    private readonly debounceMs;
    private readonly syncFn;
    private readonly onSyncComplete?;
    private readonly onSyncError?;
    constructor(projectRoot: string, syncFn: () => Promise<{
        filesChanged: number;
        durationMs: number;
    }>, options?: WatchOptions);
    start(): boolean;
    stop(): void;
    isActive(): boolean;
    getPendingFiles(): PendingFile[];
    private shouldIgnore;
    private isSourceFile;
    private scheduleSync;
    private flush;
}
//# sourceMappingURL=watcher.d.ts.map