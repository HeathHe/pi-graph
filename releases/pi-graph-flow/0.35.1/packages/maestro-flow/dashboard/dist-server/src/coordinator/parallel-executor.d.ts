import type { AgentType } from './graph-types.js';
import type { ParallelCliRunner } from '../agents/parallel-cli-runner.js';
export interface BranchTask {
    branchId: string;
    nodeId: string;
    prompt: string;
    workDir: string;
    agentType: AgentType;
}
export interface BranchResult {
    branchId: string;
    success: boolean;
    output: string;
    durationMs: number;
}
export interface ParallelCommandExecutor {
    executeBranches(branches: BranchTask[], joinStrategy: 'all' | 'any' | 'majority', signal?: AbortSignal): Promise<BranchResult[]>;
}
export declare class DefaultParallelExecutor implements ParallelCommandExecutor {
    private readonly runner;
    constructor(runner: ParallelCliRunner);
    executeBranches(branches: BranchTask[], joinStrategy: 'all' | 'any' | 'majority', signal?: AbortSignal): Promise<BranchResult[]>;
}
