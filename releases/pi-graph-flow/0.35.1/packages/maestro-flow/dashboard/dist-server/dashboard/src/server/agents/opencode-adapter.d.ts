import type { AgentConfig, AgentProcess, ApprovalDecision } from '../../shared/agent-types.js';
import { BaseAgentAdapter } from './base-adapter.js';
export declare class OpenCodeAdapter extends BaseAgentAdapter {
    readonly agentType: "opencode";
    private readonly childProcesses;
    private readonly readlineInterfaces;
    private readonly streamMonitors;
    private readonly stoppedEmitted;
    protected doSpawn(processId: string, config: AgentConfig): Promise<AgentProcess>;
    protected doStop(processId: string): Promise<void>;
    protected doSendMessage(_processId: string, _content: string): Promise<void>;
    protected doRespondApproval(_decision: ApprovalDecision): Promise<void>;
    private parseOpenCodeMessage;
    private setupProcessListeners;
    private emitStopped;
    private cleanup;
}
