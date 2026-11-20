import type { AgentType, AgentConfig, AgentProcess, NormalizedEntry, ApprovalRequest, ApprovalDecision } from '../../shared/agent-types.js';
/** Protocol-agnostic agent interface */
export interface AgentAdapter {
    readonly agentType: AgentType;
    spawn(config: AgentConfig): Promise<AgentProcess>;
    stop(processId: string): Promise<void>;
    sendMessage(processId: string, content: string): Promise<void>;
    onEntry(processId: string, cb: (entry: NormalizedEntry) => void): () => void;
    onApproval(processId: string, cb: (request: ApprovalRequest) => void): () => void;
    respondApproval(decision: ApprovalDecision): Promise<void>;
    supportsInteractive(): boolean;
    endInput(processId: string): void;
    getProcess(processId: string): AgentProcess | undefined;
    listProcesses(): AgentProcess[];
}
/** Abstract base class providing process tracking and event callback plumbing */
export declare abstract class BaseAgentAdapter implements AgentAdapter {
    abstract readonly agentType: AgentType;
    protected readonly processes: Map<string, AgentProcess>;
    private readonly entryCallbacks;
    private readonly approvalCallbacks;
    spawn(config: AgentConfig): Promise<AgentProcess>;
    stop(processId: string): Promise<void>;
    sendMessage(processId: string, content: string): Promise<void>;
    onEntry(processId: string, cb: (entry: NormalizedEntry) => void): () => void;
    onApproval(processId: string, cb: (request: ApprovalRequest) => void): () => void;
    respondApproval(decision: ApprovalDecision): Promise<void>;
    getProcess(processId: string): AgentProcess | undefined;
    listProcesses(): AgentProcess[];
    supportsInteractive(): boolean;
    endInput(_processId: string): void;
    /** Generate a unique process ID */
    protected generateProcessId(): string;
    /** Emit a normalized entry to all registered listeners for a process */
    protected emitEntry(processId: string, entry: NormalizedEntry): void;
    /** Emit an approval request to all registered listeners for a process */
    protected emitApproval(processId: string, request: ApprovalRequest): void;
    /** Add a process to the internal tracking map */
    protected addProcess(process: AgentProcess): void;
    /** Remove a process and clean up all associated callbacks */
    protected removeProcess(processId: string): void;
    private requireProcess;
    protected abstract doSpawn(processId: string, config: AgentConfig): Promise<AgentProcess>;
    protected abstract doStop(processId: string): Promise<void>;
    protected abstract doSendMessage(processId: string, content: string): Promise<void>;
    protected abstract doRespondApproval(decision: ApprovalDecision): Promise<void>;
}
