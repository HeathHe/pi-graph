import type { AgentConfig, AgentProcess, ApprovalDecision } from '../../shared/agent-types.js';
import { BaseAgentAdapter } from './base-adapter.js';
export declare class GeminiA2aAdapter extends BaseAgentAdapter {
    readonly agentType: "gemini-a2a";
    private readonly sessions;
    supportsInteractive(): boolean;
    protected doSpawn(processId: string, config: AgentConfig): Promise<AgentProcess>;
    protected doStop(processId: string): Promise<void>;
    protected doSendMessage(processId: string, content: string): Promise<void>;
    protected doRespondApproval(_decision: ApprovalDecision): Promise<void>;
    private sendStreamingMessage;
    private handleSseEvent;
    private rpcCall;
    private waitForReady;
    private fetchAgentCard;
    private extractTextFromParts;
    private setupProcessListeners;
    private cleanup;
}
