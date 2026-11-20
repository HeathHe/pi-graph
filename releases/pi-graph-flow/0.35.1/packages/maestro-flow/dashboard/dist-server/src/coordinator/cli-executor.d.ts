import type { AgentType, CommandExecutor, ExecuteRequest, ExecuteResult } from './graph-types.js';
export type SpawnFn = (config: {
    type: AgentType;
    prompt: string;
    workDir: string;
    approvalMode: 'suggest' | 'auto';
    model?: string;
    signal?: AbortSignal;
}) => Promise<{
    output: string;
    success: boolean;
    execId: string;
    durationMs: number;
}>;
export declare class CliExecutor implements CommandExecutor {
    private readonly spawn;
    private abortController;
    constructor(spawn: SpawnFn);
    execute(request: ExecuteRequest): Promise<ExecuteResult>;
    abort(): Promise<void>;
}
