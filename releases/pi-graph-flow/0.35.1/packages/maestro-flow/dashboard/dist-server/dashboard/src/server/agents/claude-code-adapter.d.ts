import type { AgentConfig, AgentProcess, ApprovalDecision } from '../../shared/agent-types.js';
import { BaseAgentAdapter } from './base-adapter.js';
export declare class ClaudeCodeAdapter extends BaseAgentAdapter {
    readonly agentType: "claude-code";
    private readonly childProcesses;
    private readonly readlineInterfaces;
    private readonly pendingApprovals;
    private readonly streamMonitors;
    private readonly resultTimers;
    private readonly stoppedEmitted;
    private readonly interactiveProcesses;
    /** Whether this adapter supports interactive follow-up messages */
    supportsInteractive(): boolean;
    protected doSpawn(processId: string, config: AgentConfig): Promise<AgentProcess>;
    protected doStop(processId: string): Promise<void>;
    /** Close stdin to signal no more input — process exits naturally after finishing current work */
    endInput(processId: string): void;
    protected doSendMessage(processId: string, content: string): Promise<void>;
    protected doRespondApproval(decision: ApprovalDecision): Promise<void>;
    private parseClaudeMessage;
    private extractAssistantContent;
    private handlePermissionRequest;
    /**
     * After receiving a 'result' message, give the process 10s to exit naturally.
     * If it doesn't, force-kill it. This handles Claude CLI hanging after
     * completion (stdin closed but process doesn't exit on Windows).
     */
    private startResultTimer;
    private emitStopped;
    private setupProcessListeners;
    private cleanup;
}
