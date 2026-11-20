import type { DashboardEventBus } from '../state/event-bus.js';
import type { AgentManager } from '../agents/agent-manager.js';
import type { McpSdkServerConfigWithInstance, McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { RoomMailbox } from './room-mailbox.js';
import { RoomTaskBoard } from './room-task-board.js';
import { RoomAgentRegistry } from './room-agent-registry.js';
import type { MeetingRoomMcpServerInfo } from './mcp-server/meeting-room-mcp-server.js';
import type { StdioMcpConfig } from './mcp-server/mcp-config-builder.js';
import type { RoomSessionStatus, RoomSessionSnapshot, RoomMailboxMessage, RoomTask, RoomTaskCreate, RoomTaskUpdate, RoomAgent, RoomAgentStatus, MessagePriority } from './room-types.js';
export type RoomMcpAgentType = 'claude-code' | 'codex' | 'agent-sdk';
export declare class MeetingRoomSession {
    private readonly eventBus;
    readonly sessionId: string;
    private status;
    private readonly createdAt;
    readonly mailbox: RoomMailbox;
    readonly taskBoard: RoomTaskBoard;
    readonly agentRegistry: RoomAgentRegistry;
    private mcpServer;
    private mcpServerInfo;
    constructor(sessionId: string, eventBus: DashboardEventBus, agentManager: AgentManager);
    addAgent(role: string, processId?: string): RoomAgent;
    removeAgent(role: string): boolean;
    setAgentStatus(role: string, status: RoomAgentStatus): boolean;
    getAgents(): RoomAgent[];
    /** Send a message to a specific agent, write to mailbox + emit event + wake agent */
    sendMessage(from: string, to: string, content: string, priority?: MessagePriority): Promise<RoomMailboxMessage>;
    /** Broadcast a message to all agents */
    broadcastMessage(from: string, content: string, priority?: MessagePriority): Promise<RoomMailboxMessage>;
    createTask(input: RoomTaskCreate): RoomTask;
    updateTask(taskId: string, patch: RoomTaskUpdate): RoomTask | undefined;
    getTasks(): RoomTask[];
    /** Start the MCP TCP server. Must be called before getMcpConfig(). */
    startMcp(): Promise<MeetingRoomMcpServerInfo>;
    /** Stop the MCP TCP server and release resources. */
    stopMcp(): Promise<void>;
    /** Get MCP server info (port + token) for HTTP transport. */
    getMcpInfo(): MeetingRoomMcpServerInfo | null;
    /**
     * Get MCP config for a specific adapter type and agent.
     * - 'claude-code': returns McpStdioServerConfig for --mcp-config
     * - 'codex': returns StdioMcpConfig with env vars
     * - 'agent-sdk': returns McpSdkServerConfigWithInstance for in-process SDK
     */
    getMcpConfig(agentType: RoomMcpAgentType, agentId: string): McpStdioServerConfig | StdioMcpConfig | McpSdkServerConfigWithInstance;
    getSnapshot(): RoomSessionSnapshot;
    getStatus(): RoomSessionStatus;
    pause(): void;
    resume(): void;
    destroy(): Promise<void>;
}
