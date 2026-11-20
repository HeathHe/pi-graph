import type { MeetingRoomSession } from '../meeting-room-session.js';
export interface McpToolRequest {
    id: string;
    token: string;
    agentId: string;
    tool: string;
    args: Record<string, unknown>;
}
export interface McpToolResponse {
    id: string;
    result?: unknown;
    error?: string;
}
export interface MeetingRoomMcpServerInfo {
    port: number;
    token: string;
}
export declare class MeetingRoomMcpServer {
    private readonly session;
    private server;
    private readonly token;
    private port;
    private readonly connections;
    constructor(session: MeetingRoomSession);
    start(): Promise<MeetingRoomMcpServerInfo>;
    destroy(): Promise<void>;
    getInfo(): MeetingRoomMcpServerInfo;
    private handleConnection;
    private handleMessage;
    private handleToolCall;
    private toolSendMessage;
    private toolReadMessages;
    private toolCreateTask;
    private toolUpdateTask;
    private toolListTasks;
    private toolGetAgents;
    private toolSpawnAgent;
    private toolShutdownAgent;
    /**
     * Fire-and-forget wake after task completion.
     * Wakes the task owner and any agents whose tasks became unblocked.
     */
    private safeWakeAfterTaskComplete;
}
