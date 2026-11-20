import type { AgentType } from './agent-types.js';
export interface ExecutionSlot {
    issueId: string;
    processId: string;
    executor: AgentType;
    startedAt: string;
    lastActivityAt: string;
    /** Current turn number (1-based) for multi-turn continuation */
    turnNumber: number;
    /** Maximum turns allowed for this execution */
    maxTurns: number;
}
export type IssueExecutionStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'retrying';
export interface ExecutionResult {
    summary?: string;
    commitHash?: string;
    prUrl?: string;
    filesChanged?: number;
}
export interface IssueExecution {
    status: IssueExecutionStatus;
    processId?: string;
    startedAt?: string;
    completedAt?: string;
    retryCount: number;
    lastError?: string;
    result?: ExecutionResult;
}
export type PromptMode = 'direct' | 'skill' | 'template' | 'decompose' | 'assessment' | 'custom';
export type DispatchStrategyName = 'priority' | 'smart' | 'commander';
/** @deprecated Use DispatchStrategyName */
export type SupervisorStrategy = DispatchStrategyName;
export interface WorkspacePolicy {
    /** Enable per-issue workspace isolation */
    enabled: boolean;
    /** Use git worktree (true) or plain directory (false) */
    useWorktree: boolean;
    /** Auto-cleanup workspaces after completion */
    autoCleanup: boolean;
    /** Strict mode: fail execution if workspace creation fails (instead of falling back to cwd) */
    strict: boolean;
}
export interface SchedulerConfig {
    enabled: boolean;
    strategy: DispatchStrategyName;
    pollIntervalMs: number;
    maxConcurrentAgents: number;
    stallTimeoutMs: number;
    maxRetries: number;
    retryBackoffMs: number;
    defaultPromptMode: PromptMode;
    defaultExecutor: AgentType;
    workspace: WorkspacePolicy;
    /** When true, all dispatch decisions are mode='suggest' (recommendations only, not auto-executed) */
    requireApproval?: boolean;
    /** Maximum continuation turns per issue for codex-server (default 3) */
    maxTurnsPerIssue?: number;
}
/** @deprecated Use SchedulerConfig */
export type SupervisorConfig = SchedulerConfig;
export declare const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig;
/** @deprecated Use DEFAULT_SCHEDULER_CONFIG */
export declare const DEFAULT_SUPERVISOR_CONFIG: SchedulerConfig;
export interface SchedulerStatus {
    enabled: boolean;
    running: ExecutionSlot[];
    queued: string[];
    retrying: {
        issueId: string;
        retryAt: string;
    }[];
    lastTickAt: string | null;
    isCommanderActive: boolean;
    stats: {
        totalDispatched: number;
        totalCompleted: number;
        totalFailed: number;
    };
    tokenUsage?: {
        totalInputTokens: number;
        totalOutputTokens: number;
    };
}
/** @deprecated Use SchedulerStatus */
export type SupervisorStatus = SchedulerStatus;
export type SupervisorTab = 'commander' | 'executions' | 'coordinator' | 'prompts' | 'extensions' | 'learning' | 'schedule';
