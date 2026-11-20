import type { AgentManager } from './agent-manager.js';
import type { DashboardEventBus } from '../state/event-bus.js';
import { type DelegateBrokerApi } from '../../../../src/async/index.js';
export interface DelegateBrokerMonitorOptions {
    agentManager: AgentManager;
    eventBus: DashboardEventBus;
    broker?: DelegateBrokerApi;
    sessionId?: string;
    pollIntervalMs?: number;
    pollLimit?: number;
}
export declare class DelegateBrokerMonitor {
    private readonly agentManager;
    private readonly eventBus;
    private readonly broker;
    private readonly sessionId;
    private readonly pollIntervalMs;
    private readonly pollLimit;
    private readonly jobState;
    private pollTimer;
    private polling;
    private running;
    constructor(options: DelegateBrokerMonitorOptions);
    start(): void;
    stop(): void;
    private poll;
    private handleEvent;
    private ensureProcess;
    private pushEntry;
}
