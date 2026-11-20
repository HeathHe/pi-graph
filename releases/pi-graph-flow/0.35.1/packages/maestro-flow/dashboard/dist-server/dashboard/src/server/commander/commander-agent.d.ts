import type { CommanderConfig, CommanderState } from '../../shared/commander-types.js';
import type { DashboardEventBus } from '../state/event-bus.js';
import type { StateManager } from '../state/state-manager.js';
import type { ExecutionScheduler } from '../execution/execution-scheduler.js';
import type { AgentManager } from '../agents/agent-manager.js';
export declare class CommanderAgent {
    private readonly eventBus;
    private readonly stateManager;
    private readonly executionScheduler;
    private readonly agentManager;
    private readonly workflowRoot;
    private config;
    private state;
    private recentDecisions;
    private consecutiveFailures;
    private ticksThisHour;
    private hourResetTimer;
    private previousStrategyName;
    constructor(eventBus: DashboardEventBus, stateManager: StateManager, executionScheduler: ExecutionScheduler, agentManager: AgentManager, workflowRoot: string, config?: Partial<CommanderConfig>);
    /** Start the Commander — registers CommanderStrategy with the scheduler. */
    start(): Promise<void>;
    /** Stop the Commander — reverts scheduler to previous strategy. */
    stop(): void;
    /** Pause — keep timer running but skip ticks. */
    pause(): void;
    /** Resume from paused state. */
    resume(): void;
    /** Update config at runtime. */
    updateConfig(partial: Partial<CommanderConfig>): void;
    /** Get current state snapshot. */
    getState(): CommanderState;
    /** Get current config snapshot. */
    getConfig(): CommanderConfig;
    /**
     * Single tick of the Commander loop:
     *   1. Gather context
     *   2. Assess (Agent SDK query, read-only)
     *   3. Decide (deterministic filtering)
     *   4. Dispatch (execute approved actions)
     *   5. Emit events
     */
    tick(trigger?: string): Promise<void>;
    private gatherContext;
    private assess;
    private decide;
    private dispatch;
    private persistDecision;
    private emitStatus;
}
