import type { CoordinateSession } from '../../shared/coordinate-types.js';
import type { DashboardEventBus } from '../state/event-bus.js';
import type { AgentManager } from '../agents/agent-manager.js';
import type { StateManager } from '../state/state-manager.js';
export interface CoordinateStartOpts {
    tool?: string;
    autoMode?: boolean;
    chainName?: string;
    phase?: string;
}
export declare class WorkflowCoordinator {
    private readonly eventBus;
    private readonly agentManager;
    private readonly stateManager;
    private readonly workflowRoot;
    private session;
    private readonly qualityReviewer;
    private readonly factory;
    private graphWalker;
    private graphWalkerInitPromise;
    constructor(eventBus: DashboardEventBus, agentManager: AgentManager, stateManager: StateManager, workflowRoot: string);
    private getGraphWalker;
    start(intent: string, opts?: CoordinateStartOpts): Promise<CoordinateSession>;
    stop(): Promise<void>;
    resume(sessionId?: string): Promise<CoordinateSession | null>;
    clarify(_sessionId: string, _response: string): Promise<void>;
    getSession(): CoordinateSession | null;
    destroy(): void;
    private startViaGraphWalker;
    private runGraphWalker;
    /** Convert WalkerState history -> CoordinateSession steps */
    private syncWalkerToSession;
    private stopViaGraphWalker;
    private resumeViaGraphWalker;
    private get sessionDir();
    private persistState;
    private loadState;
    private emitStatus;
}
