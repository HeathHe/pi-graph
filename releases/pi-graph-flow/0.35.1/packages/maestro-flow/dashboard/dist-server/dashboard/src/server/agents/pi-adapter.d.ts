import type { AgentConfig, AgentProcess, ApprovalDecision } from '../../shared/agent-types.js';
import { BaseAgentAdapter } from './base-adapter.js';
export declare class PiAdapter extends BaseAgentAdapter {
    readonly agentType: "pi";
    private readonly childProcesses;
    private readonly readlineInterfaces;
    private readonly streamMonitors;
    private readonly stoppedEmitted;
    /** Accumulated thinking deltas for the current assistant message. */
    private readonly thinkingBuffers;
    /** True when text deltas were streamed for the current assistant message —
     *  the final message_end text is then skipped (already streamed). */
    private readonly textStreamed;
    /** Tool results already emitted from tool_execution_end, keyed by Pi call id. */
    private readonly completedToolCallIds;
    protected doSpawn(processId: string, config: AgentConfig): Promise<AgentProcess>;
    protected doStop(processId: string): Promise<void>;
    protected doSendMessage(_processId: string, _content: string): Promise<void>;
    protected doRespondApproval(_decision: ApprovalDecision): Promise<void>;
    protected buildArgs(config: AgentConfig): string[];
    private parseEvent;
    private handleMessageUpdate;
    private handleMessageEnd;
    private handleToolExecutionEnd;
    private handleUsage;
    private setupProcessListeners;
    private emitErrored;
    private emitStopped;
    private cleanup;
}
