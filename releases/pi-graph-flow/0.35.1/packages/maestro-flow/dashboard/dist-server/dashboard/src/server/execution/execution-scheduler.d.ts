import type { AgentType } from '../../shared/agent-types.js';
import type { ExecutionSlot, SchedulerConfig, SchedulerStatus } from '../../shared/execution-types.js';
import type { AgentManager } from '../agents/agent-manager.js';
import type { DashboardEventBus } from '../state/event-bus.js';
import { PromptRegistry } from '../prompt/prompt-registry.js';
import type { ExecutionJournal } from './execution-journal.js';
import type { DispatchStrategy } from './dispatch-strategy.js';
import type { SelfLearningService } from '../supervisor/self-learning-service.js';
export declare class ExecutionScheduler {
    private readonly agentManager;
    private readonly eventBus;
    private readonly jsonlPath;
    private readonly journal?;
    private readonly runningSlots;
    private readonly queue;
    private readonly retryQueue;
    private readonly claimed;
    private config;
    private readonly workspaceManager;
    private readonly promptRegistry;
    private tickTimer;
    private lastTickAt;
    private stats;
    private tokenUsage;
    private readonly strategies;
    private activeStrategy;
    private selfLearningService?;
    private isDispatching;
    isCommanderActive: boolean;
    private readonly factory;
    constructor(agentManager: AgentManager, eventBus: DashboardEventBus, jsonlPath: string, config?: Partial<SchedulerConfig>, promptRegistry?: PromptRegistry, journal?: ExecutionJournal | undefined, selfLearningService?: SelfLearningService);
    /** Dispatch a single issue for execution */
    executeIssue(issueId: string, executor?: AgentType): Promise<void>;
    /** Enqueue multiple issues for batch execution */
    executeBatch(issueIds: string[], executor?: AgentType, maxConcurrency?: number): Promise<void>;
    /** Cancel a running or queued issue */
    cancelIssue(issueId: string): Promise<void>;
    /** Start the automatic dispatch tick loop */
    enableAutoDispatch(): void;
    /** @deprecated Use enableAutoDispatch() */
    startSupervisor(): void;
    /** Stop automatic dispatch */
    disableAutoDispatch(): void;
    /** @deprecated Use disableAutoDispatch() */
    stopSupervisor(): void;
    /** Update scheduler config */
    updateConfig(partial: Partial<SchedulerConfig>): void;
    /** Get a snapshot of current scheduler state */
    getStatus(): SchedulerStatus;
    /** Get config */
    getConfig(): SchedulerConfig;
    /** Get the execution slot for a given issue */
    getSlotForIssue(issueId: string): ExecutionSlot | undefined;
    /** Register a dispatch strategy (overwrites if name already exists). */
    registerStrategy(strategy: DispatchStrategy): void;
    /** Switch the active dispatch strategy by name. Throws if not registered. */
    setStrategy(name: string): void;
    /** Get the name of the active dispatch strategy. */
    getActiveStrategyName(): string;
    /** Acquire a slot for external use (e.g., WaveExecutor subtasks). Returns false if no capacity. */
    acquireSlot(issueId: string, processId: string, executor: AgentType): boolean;
    /** Release a slot after external use */
    releaseSlot(processId: string): void;
    /** Wait for a slot to become available, with timeout. Resolves true if acquired, false on timeout. */
    waitForSlot(issueId: string, processId: string, executor: AgentType, timeoutMs?: number): Promise<boolean>;
    /** Clean shutdown */
    destroy(): Promise<void>;
    /** Atomically claim an issue. Returns true if successfully claimed. */
    private claim;
    /** Recover in-memory state from persisted JSONL on startup */
    private recoverState;
    private dispatch;
    /**
     * Chain-based dispatch — routes issue execution through a GraphWalker chain.
     * The chain (e.g., 'issue-lifecycle') defines the multi-step execution flow.
     */
    private dispatchViaChain;
    private buildPrompt;
    /** Inline fallback — preserves original logic for backward compatibility */
    private buildPromptFallback;
    /** Simple variable substitution for custom prompt templates */
    private applyTemplate;
    private subscribeToAgentEvents;
    private handleAgentStopped;
    /**
     * Handle turn/completed notification from a codex-server agent.
     * The process is still alive — attempt continuation or complete.
     */
    private handleTurnCompleted;
    private handleCompletion;
    /** Extract structured result from agent entry history */
    private extractResult;
    private handleFailure;
    /**
     * Attempt to continue a codex-server agent for another turn.
     * Returns true if continuation was initiated; false if normal completion should proceed.
     */
    private attemptContinuation;
    /** Build a continuation prompt for multi-turn execution */
    private buildContinuationPrompt;
    private tick;
    /** Delegate issue selection to the active strategy and execute returned decisions. */
    private dispatchViaStrategy;
    /**
     * Reconcile running slots against persisted issue state.
     * If an issue was externally resolved or closed, stop its agent.
     */
    private reconcileRunningIssues;
    private detectStalls;
    private processRetries;
    private dispatchNext;
    private findIssue;
    /** Atomically update multiple fields on an issue in a single read-modify-write */
    private updateIssueFields;
    private emitStatus;
}
