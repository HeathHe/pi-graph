// src/graph/kg/sync/incremental-sync.ts — 增量同步
// 参考: plan-maestrograph.md D2.4 同步优先级调度 + D1.4 FileLock
import { hashFile } from '../../sync/content-hash.js';
export { FileLock } from './file-lock.js';
/**
 * 增量同步入口 — 协调知识源和代码源的同步
 *
 * D2.4: 知识源 (domain/spec/knowhow) 高优先级同步, 代码源异步后台
 */
export async function runIncrementalSync(mg, projectPath, options) {
    const { syncKnowledgeGraph } = await import('../extraction/orchestrator.js');
    return syncKnowledgeGraph(projectPath, {
        full: options?.full,
        sources: options?.sources,
        graph: mg,
    });
}
// ---------------------------------------------------------------------------
// File hash diff — 检测文件变更
// ---------------------------------------------------------------------------
export function computeFileHash(filePath) {
    try {
        // 截断前 16 位、错误返回 '' — 保留原有对外契约，底层复用共享 hashFile。
        return hashFile(filePath, { truncate: 16 });
    }
    catch {
        return '';
    }
}
export function hasFileChanged(filePath, storedHash) {
    const currentHash = computeFileHash(filePath);
    return currentHash !== storedHash;
}
//# sourceMappingURL=incremental-sync.js.map