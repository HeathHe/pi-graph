import type { AgentConfig, AgentProcess, ApprovalDecision } from '../../shared/agent-types.js';
import { BaseAgentAdapter } from './base-adapter.js';
export interface CodexAppServerConfig {
    /** Codex command. Defaults to 'codex app-server' */
    command?: string;
    /** Approval policy: 'never' (auto-approve all) or 'unless-allow-listed' */
    approvalPolicy?: string;
    /** Thread sandbox: 'workspace-write' */
    threadSandbox?: string;
}
export declare class CodexAppServerAdapter extends BaseAgentAdapter {
    readonly agentType: "codex-server";
    supportsInteractive(): boolean;
    private readonly sessions;
    private readonly appConfig;
    constructor(config?: CodexAppServerConfig);
    protected doSpawn(processId: string, config: AgentConfig): Promise<AgentProcess>;
    protected doStop(processId: string): Promise<void>;
    protected doSendMessage(processId: string, content: string): Promise<void>;
    protected doRespondApproval(decision: ApprovalDecision): Promise<void>;
    private startTurn;
    private rpcCall;
    private sendNotification;
    /** Send a JSON-RPC 2.0 response to a server-initiated request (e.g. approval) */
    private sendRpcResponse;
    private handleLine;
    private handleNotification;
    private classifyItem;
    /** Get the last assistant message for a process (O(1) without re-parsing JSONL). */
    getLastMessage(processId: string): string;
    /** Map codex item type/name to a semantic phase label. */
    private inferPhase;
    private extractText;
    private setupProcessListeners;
    private cleanup;
}
