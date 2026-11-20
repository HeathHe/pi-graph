import type { AgentType, AgentConfig, AgentProcess, ApprovalDecision } from '../../shared/agent-types.js';
import { BaseAgentAdapter } from './base-adapter.js';
export declare class StreamJsonAdapter extends BaseAgentAdapter {
    readonly agentType: AgentType;
    private readonly executable;
    private readonly childProcesses;
    private readonly readlineInterfaces;
    private readonly lastCumulativeText;
    private readonly toolIdNames;
    private readonly stoppedEmitted;
    private readonly streamMonitors;
    private readonly thinkingEmitted;
    constructor(executable: string, agentType: AgentType);
    protected doSpawn(processId: string, config: AgentConfig): Promise<AgentProcess>;
    protected doStop(processId: string): Promise<void>;
    protected doSendMessage(processId: string, _content: string): Promise<void>;
    protected doRespondApproval(_decision: ApprovalDecision): Promise<void>;
    private parseStreamJsonMessage;
    private handleMessageEntry;
    protected buildArgs(config: AgentConfig): string[];
    private emitStopped;
    private setupProcessListeners;
    private cleanup;
}
