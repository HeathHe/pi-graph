import type { WalkerEventEmitter, StepAnalyzer } from '../../../../src/coordinator/graph-types.js';
import type { AgentManager } from '../agents/agent-manager.js';
import type { DashboardEventBus } from '../state/event-bus.js';
export interface GraphWalkerCreateConfig {
    agentManager: AgentManager;
    eventBus: DashboardEventBus;
    workDir: string;
    emitter: WalkerEventEmitter;
    analyzer: StepAnalyzer | null;
    sessionDir: string;
}
export declare class GraphWalkerFactory {
    private infraPromise;
    /** Cache ALL dynamic imports in a single promise on first access */
    private ensureInfra;
    /** Create a fully-wired GraphWalker + IntentRouter + DashboardExecutor */
    create(config: GraphWalkerCreateConfig): Promise<{
        walker: InstanceType<any>;
        router: InstanceType<any>;
        executor: InstanceType<any>;
    }>;
}
