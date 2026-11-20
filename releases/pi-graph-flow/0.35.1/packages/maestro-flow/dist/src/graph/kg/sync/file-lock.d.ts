export interface FileLockOptions {
    timeoutMs?: number;
    retryMs?: number;
    staleMs?: number;
}
/** Crash-safe cross-process lock for MaestroGraph write operations. */
export declare class FileLock {
    private readonly lockPath;
    private readonly options;
    constructor(lockPath: string, options?: FileLockOptions);
    withLock<T>(fn: () => Promise<T>): Promise<T>;
    private tryAcquire;
    private removeStaleLock;
    private isProcessAlive;
    private release;
}
//# sourceMappingURL=file-lock.d.ts.map