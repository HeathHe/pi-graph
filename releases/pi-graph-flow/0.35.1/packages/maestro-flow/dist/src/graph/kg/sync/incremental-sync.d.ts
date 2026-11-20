import type { MaestroGraph } from '../engine.js';
import type { SyncResult, SourceType } from '../db/types.js';
export { FileLock } from './file-lock.js';
export interface IncrementalSyncOptions {
    /** 全量重建 */
    full?: boolean;
    /** 只同步指定源 */
    sources?: SourceType[];
    /** 变更文件列表 (增量模式) */
    changedFiles?: string[];
}
/**
 * 增量同步入口 — 协调知识源和代码源的同步
 *
 * D2.4: 知识源 (domain/spec/knowhow) 高优先级同步, 代码源异步后台
 */
export declare function runIncrementalSync(mg: MaestroGraph, projectPath: string, options?: IncrementalSyncOptions): Promise<SyncResult[]>;
export declare function computeFileHash(filePath: string): string;
export declare function hasFileChanged(filePath: string, storedHash: string): boolean;
//# sourceMappingURL=incremental-sync.d.ts.map