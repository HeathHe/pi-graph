// ---------------------------------------------------------------------------
// MeetingRoomSession — thin coordinator composing subsystems + EventBus
// ---------------------------------------------------------------------------
import { RoomMailbox } from './room-mailbox.js';
import { RoomTaskBoard } from './room-task-board.js';
import { RoomAgentRegistry } from './room-agent-registry.js';
import { MeetingRoomMcpServer } from './mcp-server/meeting-room-mcp-server.js';
import { getStdioConfig, getClaudeCodeConfig, getSdkMcpServer, } from './mcp-server/mcp-config-builder.js';
export class MeetingRoomSession {
    eventBus;
    sessionId;
    status = 'active';
    createdAt;
    mailbox;
    taskBoard;
    agentRegistry;
    mcpServer = null;
    mcpServerInfo = null;
    constructor(sessionId, eventBus, agentManager) {
        this.eventBus = eventBus;
        this.sessionId = sessionId;
        this.createdAt = new Date().toISOString();
        this.mailbox = new RoomMailbox();
        this.taskBoard = new RoomTaskBoard();
        this.agentRegistry = new RoomAgentRegistry(agentManager);
    }
    // --- Agent management ---
    addAgent(role, processId) {
        const agent = this.agentRegistry.register(this.sessionId, role, processId);
        this.eventBus.emit('team:agent_status', {
            role: agent.role,
            status: agent.status,
            lastActivity: agent.lastActivityAt,
        });
        return agent;
    }
    removeAgent(role) {
        const removed = this.agentRegistry.unregister(this.sessionId, role);
        if (removed) {
            this.eventBus.emit('team:agent_status', {
                role,
                status: 'offline',
                lastActivity: new Date().toISOString(),
            });
        }
        return removed;
    }
    setAgentStatus(role, status) {
        const updated = this.agentRegistry.setStatus(this.sessionId, role, status);
        if (updated) {
            const agent = this.agentRegistry.getAgentByRole(this.sessionId, role);
            if (agent) {
                this.eventBus.emit('team:agent_status', {
                    role: agent.role,
                    status: agent.status,
                    lastActivity: agent.lastActivityAt,
                });
            }
        }
        return updated;
    }
    getAgents() {
        return this.agentRegistry.getAgents(this.sessionId);
    }
    // --- Messaging ---
    /** Send a message to a specific agent, write to mailbox + emit event + wake agent */
    async sendMessage(from, to, content, priority = 'normal') {
        const msg = this.mailbox.write(this.sessionId, from, to, content, priority);
        this.eventBus.emit('team:message', {
            id: msg.id,
            from: msg.from,
            to: msg.to,
            content: msg.content,
            dispatch_status: 'pending',
            timestamp: msg.createdAt,
        });
        // Wake the target agent
        if (to !== '*') {
            await this.agentRegistry.wake(this.sessionId, to, content);
        }
        return msg;
    }
    /** Broadcast a message to all agents */
    async broadcastMessage(from, content, priority = 'normal') {
        const msg = this.mailbox.write(this.sessionId, from, '*', content, priority);
        this.eventBus.emit('team:dispatch', {
            id: msg.id,
            from: msg.from,
            to: '*',
            content: msg.content,
            dispatch_status: 'pending',
            timestamp: msg.createdAt,
        });
        // Wake all agents
        const agents = this.agentRegistry.getAgents(this.sessionId);
        await Promise.allSettled(agents.map((agent) => this.agentRegistry.wake(this.sessionId, agent.role, content)));
        return msg;
    }
    // --- Task management ---
    createTask(input) {
        return this.taskBoard.create(this.sessionId, input);
    }
    updateTask(taskId, patch) {
        const task = this.taskBoard.update(this.sessionId, taskId, patch);
        // If task was marked completed, cascade unblocks
        if (task && patch.status === 'completed') {
            this.taskBoard.checkUnblocks(this.sessionId, taskId);
        }
        return task;
    }
    getTasks() {
        return this.taskBoard.list(this.sessionId);
    }
    // --- MCP server lifecycle ---
    /** Start the MCP TCP server. Must be called before getMcpConfig(). */
    async startMcp() {
        if (this.mcpServer) {
            return this.mcpServer.getInfo();
        }
        this.mcpServer = new MeetingRoomMcpServer(this);
        this.mcpServerInfo = await this.mcpServer.start();
        return this.mcpServerInfo;
    }
    /** Stop the MCP TCP server and release resources. */
    async stopMcp() {
        if (this.mcpServer) {
            await this.mcpServer.destroy();
            this.mcpServer = null;
            this.mcpServerInfo = null;
        }
    }
    /** Get MCP server info (port + token) for HTTP transport. */
    getMcpInfo() {
        return this.mcpServerInfo;
    }
    /**
     * Get MCP config for a specific adapter type and agent.
     * - 'claude-code': returns McpStdioServerConfig for --mcp-config
     * - 'codex': returns StdioMcpConfig with env vars
     * - 'agent-sdk': returns McpSdkServerConfigWithInstance for in-process SDK
     */
    getMcpConfig(agentType, agentId) {
        if (agentType === 'agent-sdk') {
            // SDK adapter uses in-process server -- no TCP needed
            return getSdkMcpServer(this, agentId);
        }
        // CLI adapters need the TCP server running
        if (!this.mcpServerInfo) {
            throw new Error('MCP server not started. Call startMcp() first.');
        }
        if (agentType === 'claude-code') {
            return getClaudeCodeConfig(agentId, this.mcpServerInfo);
        }
        // Default: stdio config (codex and other CLI adapters)
        return getStdioConfig(agentId, this.mcpServerInfo);
    }
    // --- Session lifecycle ---
    getSnapshot() {
        return {
            sessionId: this.sessionId,
            status: this.status,
            agents: this.agentRegistry.getAgents(this.sessionId),
            messages: this.mailbox.getHistory(this.sessionId),
            tasks: this.taskBoard.list(this.sessionId),
            createdAt: this.createdAt,
        };
    }
    getStatus() {
        return this.status;
    }
    pause() {
        this.status = 'paused';
    }
    resume() {
        this.status = 'active';
    }
    async destroy() {
        this.status = 'destroyed';
        await this.stopMcp();
        this.mailbox.clear(this.sessionId);
        this.taskBoard.clear(this.sessionId);
        this.agentRegistry.clear(this.sessionId);
    }
}
//# sourceMappingURL=meeting-room-session.js.map