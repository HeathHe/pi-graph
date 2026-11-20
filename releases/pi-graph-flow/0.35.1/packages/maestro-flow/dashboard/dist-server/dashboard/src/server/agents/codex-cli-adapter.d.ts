import type { AgentConfig, AgentProcess, ApprovalDecision } from '../../shared/agent-types.js';
import { BaseAgentAdapter } from './base-adapter.js';
export declare class CodexCliAdapter extends BaseAgentAdapter {
    readonly agentType: "codex";
    private readonly childProcesses;
    private readonly readlineInterfaces;
    private readonly streamMonitors;
    private readonly stoppedEmitted;
    /** Accumulates assistant message text within a turn; flushed on turn.completed */
    private readonly pendingMessages;
    protected doSpawn(processId: string, config: AgentConfig): Promise<AgentProcess>;
    protected doStop(processId: string): Promise<void>;
    protected doSendMessage(_processId: string, _content: string): Promise<void>;
    protected doRespondApproval(_decision: ApprovalDecision): Promise<void>;
    private parseCodexMessage;
    private classifyItem;
    /** Map codex item status/error fields to ToolUseEntry status. */
    private codexStatusToToolStatus;
    /** Parse codex function/tool `arguments` (JSON string) into an object; tolerate non-JSON. */
    private parseArguments;
    /** Heuristic: does this item.type look like a tool/shell call we should treat as a boundary? */
    private isToolLikeType;
    private isCommandCall;
    private isFileCall;
    private inferFileAction;
    /** Flush accumulated partial messages as a single final assistant_message. */
    private flushPendingMessages;
    private extractItemText;
    private emitStopped;
    private setupProcessListeners;
    private cleanup;
}
