import type { Issue } from '../../shared/issue-types.js';
import type { WaveSession } from '../../shared/wave-types.js';
import type { DashboardEventBus } from '../state/event-bus.js';
import type { AgentManager } from '../agents/agent-manager.js';
import type { ExecutionScheduler } from './execution-scheduler.js';
import type { ExecutionJournal } from './execution-journal.js';
export declare class WaveExecutor {
    private readonly eventBus;
    private readonly agentManager;
    private readonly workDir;
    private readonly executionScheduler?;
    private readonly journal?;
    private readonly sessions;
    private readonly abortControllers;
    private readonly issueMcpServerPromise;
    constructor(eventBus: DashboardEventBus, agentManager: AgentManager, workDir: string, executionScheduler?: ExecutionScheduler | undefined, journal?: ExecutionJournal | undefined);
    /**
     * Execute an issue using wave-based decomposition and parallel execution.
     * Returns a processId that can be used to track progress in the chat UI.
     */
    execute(issue: Issue): Promise<string>;
    /** Stop a running wave execution */
    stop(processId: string): void;
    /** Get session state */
    getSession(processId: string): WaveSession | undefined;
    /** Load saved agent-sdk settings and build env overrides */
    private loadSettings;
    private runWaveExecution;
    private decompose;
    private executeTask;
    private emitEntry;
}
