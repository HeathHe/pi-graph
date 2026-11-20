import type { DashboardEventBus } from '../state/event-bus.js';
import type { AgentManager } from '../agents/agent-manager.js';
import type { ExecuteRequest, ExecuteResult, CommandExecutor } from '../../../../src/coordinator/graph-types.js';
export declare class DashboardExecutor implements CommandExecutor {
    private readonly agentManager;
    private readonly eventBus;
    private activeProcessId;
    constructor(agentManager: AgentManager, eventBus: DashboardEventBus);
    execute(request: ExecuteRequest): Promise<ExecuteResult>;
    abort(): Promise<void>;
    private waitForStopped;
    private collectOutput;
}
