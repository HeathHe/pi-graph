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
export declare function knowledgeCorpusNamespaceTarget(projectRoot: string): string;
export declare function acquireFileLocksSync(filePaths: readonly string[]): () => void;
export declare function acquireKnowledgeCorpusNamespaceLockSync(projectRoot: string): () => void;
/**
 * Read-modify-write `filePath` atomically under a cross-process lock.
 *
 * `update` receives the current content (`null` when the file does not
 * exist) and returns the full new content — or `null` to skip the write
 * (e.g. duplicate detected). Returns the callback's result.
 */
export declare function updateFileAtomic(filePath: string, update: (current: string | null) => string | null): string | null;
//# sourceMappingURL=atomic-write.d.ts.map