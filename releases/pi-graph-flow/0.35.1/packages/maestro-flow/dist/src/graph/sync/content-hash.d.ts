export interface HashFileOptions {
    /** 将 hex 摘要截断到指定字符数；省略则返回完整摘要。 */
    truncate?: number;
}
/**
 * 共享的底层文件哈希 — 单一 SHA-256 实现，被 content-hash（完整摘要）与
 * kg/sync/incremental-sync（截断摘要）两处复用。读取错误时抛出，由调用方
 * 各自包裹以保留其错误/大小契约。
 */
export declare function hashFile(absolutePath: string, options?: HashFileOptions): string;
export declare function computeFileHash(absolutePath: string): string | null;
export declare function computeFileHashes(files: Array<{
    absolutePath: string;
    relPath: string;
}>): Map<string, string>;
export declare function isFileTooLarge(absolutePath: string): boolean;
//# sourceMappingURL=content-hash.d.ts.map