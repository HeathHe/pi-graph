import type { SpawnFn } from '../coordinator/cli-executor.js';
import type { TerminalBackend } from './terminal-backend.js';
export interface ParallelTask {
    id: string;
    prompt: string;
    tool: string;
    workDir: string;
    mode: 'analysis' | 'write';
    backend?: 'direct' | 'terminal';
    sessionKey?: string;
}
export interface ParallelResult {
    id: string;
    success: boolean;
    output: string;
    execId: string;
    durationMs: number;
}
export interface RunAllOptions {
    maxConcurrency?: number;
    joinStrategy: 'all' | 'any' | 'majority';
    signal?: AbortSignal;
}
export declare class ParallelCliRunner {
    private readonly spawn;
    private readonly terminalBackend?;
    constructor(spawn: SpawnFn, terminalBackend?: TerminalBackend | undefined);
    /**
     * Execute tasks in parallel with session-key grouping and join strategy.
     *
     * Tasks sharing the same sessionKey (defaults to tool+workDir) execute
     * serially within their group. Different groups run in parallel, limited
     * by maxConcurrency.
     */
    runAll(tasks: ParallelTask[], options: RunAllOptions): Promise<{
        results: ParallelResult[];
        success: boolean;
    }>;
    private groupBySession;
    private runSessionGroup;
    private executeTask;
    private executeViaSpawn;
    private executeViaTerminal;
    private evaluateJoin;
}
