import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
// ---------------------------------------------------------------------------
// RoomWsHandler — client-to-server room actions
//   room:create           -> create a new room session
//   room:close            -> destroy a room session
//   room:subscribe        -> subscribe to session events + get snapshot
//   room:unsubscribe      -> unsubscribe from session events
//   room:add_agent        -> add agent to session
//   room:remove_agent     -> remove agent from session
//   room:set_agent_status -> update agent status
//   room:send_message     -> send message to specific agent
//   room:broadcast        -> broadcast message to all agents
//   room:create_task      -> create a task
//   room:update_task      -> update a task
//   room:snapshot         -> request current snapshot
// ---------------------------------------------------------------------------
export class RoomWsHandler {
    sessionManager;
    eventBus;
    filter;
    workflowRoot;
    actions = [
        'room:create',
        'room:close',
        'room:subscribe',
        'room:unsubscribe',
        'room:add_agent',
        'room:remove_agent',
        'room:set_agent_status',
        'room:send_message',
        'room:broadcast',
        'room:create_task',
        'room:update_task',
        'room:snapshot',
    ];
    constructor(sessionManager, eventBus, filter, workflowRoot) {
        this.sessionManager = sessionManager;
        this.eventBus = eventBus;
        this.filter = filter;
        this.workflowRoot = workflowRoot;
    }
    async handle(action, data, ws, _broadcast) {
        const msg = data;
        const sessionId = (msg.sessionId ?? msg.roomId);
        switch (action) {
            case 'room:create': {
                const session = this.sessionManager.createSession(sessionId);
                // Start MCP TCP server for this room (agents will connect to it)
                await session.startMcp();
                // Auto-subscribe the creator so they receive room:created and all subsequent events
                this.filter.subscribe(ws, sessionId);
                const snapshot = session.getSnapshot();
                this.eventBus.emit('room:created', {
                    sessionId: snapshot.sessionId,
                    status: snapshot.status,
                    agentCount: snapshot.agents.length,
                    taskCount: snapshot.tasks.length,
                    messageCount: snapshot.messages.length,
                    createdAt: snapshot.createdAt,
                });
                break;
            }
            case 'room:close': {
                const destroyed = await this.sessionManager.destroySession(sessionId);
                if (destroyed) {
                    this.eventBus.emit('room:closed', { sessionId });
                    // Clean up meeting-room entry from .mcp.json
                    this.cleanupMcpJson();
                }
                break;
            }
            case 'room:subscribe': {
                this.filter.subscribe(ws, sessionId);
                // Send current snapshot to the subscribing client
                const session = this.sessionManager.getSession(sessionId);
                if (session) {
                    const snapshot = session.getSnapshot();
                    this.eventBus.emit('room:snapshot', snapshot);
                }
                break;
            }
            case 'room:unsubscribe': {
                this.filter.unsubscribe(ws, sessionId);
                break;
            }
            case 'room:add_agent': {
                const session = this.sessionManager.getSession(sessionId);
                if (!session)
                    break;
                const agent = session.addAgent(msg.role, msg.processId);
                this.eventBus.emit('room:agent_joined', { sessionId, agent });
                break;
            }
            case 'room:remove_agent': {
                const session = this.sessionManager.getSession(sessionId);
                if (!session)
                    break;
                const removed = session.removeAgent(msg.role);
                if (removed) {
                    this.eventBus.emit('room:agent_left', {
                        sessionId,
                        role: msg.role,
                    });
                }
                break;
            }
            case 'room:set_agent_status': {
                const session = this.sessionManager.getSession(sessionId);
                if (!session)
                    break;
                session.setAgentStatus(msg.role, msg.status);
                this.eventBus.emit('room:agent_status', {
                    sessionId,
                    role: msg.role,
                    status: msg.status,
                });
                break;
            }
            case 'room:send_message': {
                const session = this.sessionManager.getSession(sessionId);
                if (!session)
                    break;
                const from = msg.from || 'user';
                const mailMsg = await session.sendMessage(from, msg.to, msg.content, msg.priority || 'normal');
                this.eventBus.emit('room:message', { sessionId, message: mailMsg });
                break;
            }
            case 'room:broadcast': {
                const session = this.sessionManager.getSession(sessionId);
                if (!session)
                    break;
                const bcastFrom = msg.from || 'user';
                const bcastMsg = await session.broadcastMessage(bcastFrom, msg.content, msg.priority || 'normal');
                this.eventBus.emit('room:broadcast', { sessionId, message: bcastMsg });
                break;
            }
            case 'room:create_task': {
                const session = this.sessionManager.getSession(sessionId);
                if (!session)
                    break;
                // Accept both nested msg.task and flat fields
                const taskInput = msg.task ?? {
                    title: msg.title,
                    description: msg.description ?? '',
                    owner: msg.assignedTo ?? msg.owner,
                    blockedBy: msg.blockedBy,
                };
                const task = session.createTask(taskInput);
                this.eventBus.emit('room:task_created', { sessionId, task });
                break;
            }
            case 'room:update_task': {
                const session = this.sessionManager.getSession(sessionId);
                if (!session)
                    break;
                const updated = session.updateTask(msg.taskId, msg.patch);
                if (updated) {
                    this.eventBus.emit('room:task_updated', { sessionId, task: updated });
                }
                break;
            }
            case 'room:snapshot': {
                const session = this.sessionManager.getSession(sessionId);
                if (session) {
                    this.eventBus.emit('room:snapshot', session.getSnapshot());
                }
                break;
            }
        }
    }
    /** Remove the meeting-room entry from .mcp.json after room destruction. */
    cleanupMcpJson() {
        if (!this.workflowRoot)
            return;
        const projectRoot = resolve(this.workflowRoot, '..');
        const mcpJsonPath = join(projectRoot, '.mcp.json');
        try {
            if (!existsSync(mcpJsonPath))
                return;
            const config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
            if (config.mcpServers?.['meeting-room']) {
                delete config.mcpServers['meeting-room'];
                writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2));
            }
        }
        catch {
            // Best-effort cleanup
        }
    }
}
//# sourceMappingURL=room-handler.js.map