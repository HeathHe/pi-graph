import type { AgentProcessStatus, UserMessageEntry, AssistantMessageEntry, ThinkingEntry, ToolUseEntry, FileChangeEntry, CommandExecEntry, ApprovalRequestEntry, ApprovalResponseEntry, ErrorEntry, StatusChangeEntry, TokenUsageEntry } from '../../shared/agent-types.js';
/** Factory for creating NormalizedEntry instances with consistent base fields */
export declare class EntryNormalizer {
    private static partialCounter;
    private constructor();
    static userMessage(processId: string, content: string): UserMessageEntry;
    static assistantMessage(processId: string, content: string, partial: boolean): AssistantMessageEntry;
    static thinking(processId: string, content: string): ThinkingEntry;
    static toolUse(processId: string, name: string, input: Record<string, unknown>, status: ToolUseEntry['status'], result?: string): ToolUseEntry;
    static fileChange(processId: string, path: string, action: FileChangeEntry['action'], diff?: string): FileChangeEntry;
    static commandExec(processId: string, command: string, exitCode?: number, output?: string): CommandExecEntry;
    static approvalRequest(processId: string, toolName: string, toolInput: Record<string, unknown>, requestId: string): ApprovalRequestEntry;
    static approvalResponse(processId: string, requestId: string, allowed: boolean): ApprovalResponseEntry;
    static error(processId: string, message: string, code?: string): ErrorEntry;
    static statusChange(processId: string, status: AgentProcessStatus, reason?: string): StatusChangeEntry;
    static tokenUsage(processId: string, inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number): TokenUsageEntry;
}
