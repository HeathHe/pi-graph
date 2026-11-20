/**
 * KG Sync Hook — UserPromptSubmit
 *
 * Detects repository and exact external-surface changes from any nested cwd,
 * then delegates one transactionally-watermarked sync to a detached worker.
 */
import { type KgSyncWorkerMode } from './kg-sync-worker-state.js';
export interface KgSyncResult {
    synced: boolean;
    reason?: string;
    filesChanged?: number;
    durationMs?: number;
    projectRoot?: string;
    workerMode?: KgSyncWorkerMode | 'foreign';
}
export interface GitPorcelainEntry {
    status: string;
    paths: string[];
}
/**
 * Public entry accepts a nested cwd, but every guard and state path is keyed by
 * the one canonical Maestro project root.
 */
export declare function evaluateKgSync(projectPath: string, sessionId: string): Promise<KgSyncResult>;
/** Parse `git status --porcelain=v1 -z` without trimming path bytes. */
export declare function parseGitPorcelainZ(output: string | Buffer): GitPorcelainEntry[];
export declare function gitEntriesContainSupportedSource(entries: readonly GitPorcelainEntry[]): boolean;
export declare function detectSourceChanges(projectRoot: string): boolean;
/** Same session in two repositories must never share a cooldown bridge. */
export declare function kgSyncCooldownKey(sessionId: string, canonicalProjectRoot: string): string;
//# sourceMappingURL=kg-sync-hook.d.ts.map