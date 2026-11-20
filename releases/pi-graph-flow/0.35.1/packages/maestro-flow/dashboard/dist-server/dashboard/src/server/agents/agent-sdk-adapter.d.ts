import type { AgentConfig, AgentProcess, ApprovalDecision } from '../../shared/agent-types.js';
import { BaseAgentAdapter } from './base-adapter.js';
export declare class AgentSdkAdapter extends BaseAgentAdapter {
    readonly agentType: "agent-sdk";
    private readonly abortControllers;
    private readonly pendingApprovals;
    private readonly issueMcpServerPromise;
    constructor(workflowRoot?: string);
    protected doSpawn(processId: string, config: AgentConfig): Promise<AgentProcess>;
    protected doStop(processId: string): Promise<void>;
    protected doSendMessage(_processId: string, _content: string): Promise<void>;
    protected doRespondApproval(decision: ApprovalDecision): Promise<void>;
    private runAgentQuery;
    private createCanUseToolCallback;
    private handleCanUseTool;
    private resolvePermissionMode;
    private denyAllPendingApprovals;
}
