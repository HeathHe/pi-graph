import type { WebSocket } from 'ws';
import type { WsHandler } from '../ws-handler.js';
import type { WsEventType } from '../../../shared/ws-protocol.js';
import type { AgentManager } from '../../agents/agent-manager.js';
import type { DashboardEventBus } from '../../state/event-bus.js';
import type { ExecutionScheduler } from '../../execution/execution-scheduler.js';
import type { WaveExecutor } from '../../execution/wave-executor.js';
import type { AgentWsHandler } from './agent-handler.js';
export declare class ExecutionWsHandler implements WsHandler {
    private readonly executionScheduler;
    private readonly waveExecutor;
    private readonly agentManager;
    private readonly eventBus;
    private readonly workflowRoot;
    private readonly agentHandler;
    readonly actions: readonly ["execute:issue", "execute:batch", "execute:wave", "supervisor:toggle", "issue:analyze", "issue:plan", "issue:pipeline"];
    constructor(executionScheduler: ExecutionScheduler, waveExecutor: WaveExecutor, agentManager: AgentManager, eventBus: DashboardEventBus, workflowRoot: string, agentHandler: AgentWsHandler);
    handle(action: string, data: unknown, ws: WebSocket, _broadcast: (type: WsEventType, data: unknown) => void): Promise<void>;
    private handleWaveExecute;
    private handleIssuePipeline;
    private handleIssueAnalyze;
    private handleIssuePlan;
    private buildIssuePromptAndSpawn;
}
