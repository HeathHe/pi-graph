import type { TerminalBackend } from './terminal-backend.js';
type AgentType = 'claude-code' | 'codex' | 'gemini' | 'qwen' | 'opencode' | 'pi' | 'grok';
type AgentProcessStatus = 'spawning' | 'running' | 'paused' | 'stopping' | 'stopped' | 'error';
interface AgentConfig {
    type: AgentType;
    prompt: string;
    workDir: string;
    env?: Record<string, string>;
    model?: string;
    approvalMode?: 'suggest' | 'auto';
}
interface AgentProcess {
    id: string;
    type: AgentType;
    status: AgentProcessStatus;
    config: AgentConfig;
    startedAt: string;
    pid?: number;
}
interface NormalizedEntryBase {
    id: string;
    processId: string;
    timestamp: string;
}
type NormalizedEntry = (NormalizedEntryBase & {
    type: 'user_message';
    content: string;
}) | (NormalizedEntryBase & {
    type: 'assistant_message';
    content: string;
    partial: boolean;
}) | (NormalizedEntryBase & {
    type: 'thinking';
    content: string;
}) | (NormalizedEntryBase & {
    type: 'tool_use';
    name: string;
    input: Record<string, unknown>;
    status: string;
    result?: string;
}) | (NormalizedEntryBase & {
    type: 'file_change';
    path: string;
    action: string;
    diff?: string;
}) | (NormalizedEntryBase & {
    type: 'command_exec';
    command: string;
    exitCode?: number;
    output?: string;
}) | (NormalizedEntryBase & {
    type: 'approval_request';
    toolName: string;
    toolInput: Record<string, unknown>;
    requestId: string;
}) | (NormalizedEntryBase & {
    type: 'approval_response';
    requestId: string;
    allowed: boolean;
}) | (NormalizedEntryBase & {
    type: 'error';
    message: string;
    code?: string;
}) | (NormalizedEntryBase & {
    type: 'status_change';
    status: AgentProcessStatus;
    reason?: string;
}) | (NormalizedEntryBase & {
    type: 'token_usage';
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
});
/** Minimal adapter interface matching BaseAgentAdapter's public surface */
interface AdapterLike {
    spawn(config: AgentConfig): Promise<AgentProcess>;
    stop(processId: string): Promise<void>;
    onEntry(processId: string, cb: (entry: NormalizedEntry) => void): () => void;
}
export declare class TerminalAdapter implements AdapterLike {
    private readonly backend;
    private readonly toolCmd;
    private readonly panes;
    private readonly listeners;
    constructor(backend: TerminalBackend, toolCmd: string);
    spawn(config: AgentConfig): Promise<AgentProcess>;
    stop(processId: string): Promise<void>;
    onEntry(processId: string, cb: (entry: NormalizedEntry) => void): () => void;
    private pollOutput;
    private emit;
}
export {};
//# sourceMappingURL=terminal-adapter.d.ts.map