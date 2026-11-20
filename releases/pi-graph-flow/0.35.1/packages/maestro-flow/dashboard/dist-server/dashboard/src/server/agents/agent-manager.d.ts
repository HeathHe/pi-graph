import type { AgentType, AgentConfig, AgentProcess, NormalizedEntry, ApprovalDecision } from '../../shared/agent-types.js';
import type { AgentAdapter } from './base-adapter.js';
import type { DashboardEventBus } from '../state/event-bus.js';
export declare class AgentManager {
    private readonly eventBus;
    private readonly adapters;
    private readonly processToAdapter;
    private readonly entryHistory;
    private readonly unsubscribers;
    private readonly cliProcesses;
    private readonly cliCleanupTimers;
    private readonly processExecIds;
    private readonly processConfigs;
    private readonly MAX_HISTORY;
    private readonly CLI_CLEANUP_DELAY_MS;
    constructor(eventBus: DashboardEventBus);
    private get historyDir();
    private ensureHistoryDir;
    private persistEntry;
    private persistMeta;
    /** Register an adapter for a specific agent type */
    registerAdapter(adapter: AgentAdapter): void;
    /** List registered adapter type names */
    listAdapterTypes(): AgentType[];
    /** Spawn a new agent process and wire up event forwarding */
    spawn(type: AgentType, config: AgentConfig): Promise<AgentProcess>;
    /** Stop a running agent process */
    stop(processId: string): Promise<void>;
    /** Handle agent process that stopped on its own */
    private handleAutoStop;
    /** Send a message to a running agent process */
    sendMessage(processId: string, content: string): Promise<void>;
    /** Respond to an approval request from an agent */
    respondApproval(decision: ApprovalDecision): Promise<void>;
    /** Register a CLI-bridged process (forwarded via DashboardBridge WS) */
    registerCliProcess(process: AgentProcess): void;
    /** Buffer an entry for a CLI-bridged process */
    addCliEntry(processId: string, entry: NormalizedEntry): void;
    /** Update status of a CLI-bridged process and schedule delayed cleanup */
    updateCliProcessStatus(processId: string, status: AgentProcess['status']): void;
    /** Remove a process from memory (dismiss from dashboard) */
    removeProcess(processId: string): void;
    /** List all active processes across all adapters + CLI bridge */
    listProcesses(): AgentProcess[];
    /** Get buffered entry history for a process */
    getEntries(processId: string): NormalizedEntry[];
    /** Stop all running processes (used during shutdown) */
    stopAll(): Promise<void>;
}
