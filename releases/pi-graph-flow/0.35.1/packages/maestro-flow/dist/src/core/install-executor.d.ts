import type { InstallFlowConfig } from '../tui/install-ui/types.js';
export interface InstallResult {
    filesInstalled: number;
    dirsCreated: number;
    filesSkipped: number;
    hooksInstalled: number;
    mcpRegistered: boolean;
    codexHooksInstalled: number;
    codexMcpRegistered: boolean;
    agyHooksInstalled: number;
    genericHooksInstalled: Record<string, number>;
    extraMcpRegistered: string[];
    extraMcpFailed: string[];
    manifestPath: string;
    statuslineInstalled: boolean;
    backupPath: string | null;
    migrationWarnings: string[];
    obsoleteFilesRemoved: number;
    obsoleteFilesPreserved: number;
    obsoleteFilesSkipped: number;
    obsoleteFileErrors: number;
    /** Backup of the files that were about to be pruned (restore point). */
    pruneBackupPath: string | null;
}
export type StepName = 'backup' | 'cleanup' | 'components' | 'hooks' | 'statusline' | 'mcp' | 'codexHooks' | 'codexMcp' | 'agyHooks' | 'extraMcp' | 'plugin' | 'manifest' | 'codexConfig' | `ghooks-${string}`;
export type ProgressCallback = (step: StepName, status: 'active' | 'done' | 'error', detail: string) => void;
export interface ExecutorOptions {
    config: InstallFlowConfig;
    pkgRoot: string;
    version: string;
    onProgress?: ProgressCallback;
    isCancelled?: () => boolean;
}
export declare function executeInstallPipeline(opts: ExecutorOptions): Promise<InstallResult>;
export declare class CancelledError extends Error {
    constructor();
}
//# sourceMappingURL=install-executor.d.ts.map