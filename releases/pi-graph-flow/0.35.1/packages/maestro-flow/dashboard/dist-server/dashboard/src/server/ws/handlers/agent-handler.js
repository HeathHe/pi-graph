import { WebSocket } from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDashboardAgentSettings } from '../../config.js';
import { EntryNormalizer } from '../../agents/entry-normalizer.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
async function handleDelegateMessage(params) {
    const args = ['delegate', 'message', params.execId, params.message, '--delivery', params.delivery];
    await execFileAsync('maestro', args, { timeout: 30_000 });
}
// ---------------------------------------------------------------------------
// AgentWsHandler — spawn, stop, message, approve, CLI bridge forwarding
// ---------------------------------------------------------------------------
export class AgentWsHandler {
    agentManager;
    eventBus;
    workflowRoot;
    delegateMessage;
    roomSessionManager;
    actions = [
        'spawn',
        'stop',
        'message',
        'delegate:message',
        'approve',
        'cli:spawned',
        'cli:entry',
        'cli:stopped',
    ];
    constructor(agentManager, eventBus, workflowRoot, delegateMessage = handleDelegateMessage, roomSessionManager) {
        this.agentManager = agentManager;
        this.eventBus = eventBus;
        this.workflowRoot = workflowRoot;
        this.delegateMessage = delegateMessage;
        this.roomSessionManager = roomSessionManager;
    }
    async handle(action, data, ws, broadcast) {
        const msg = data;
        switch (action) {
            case 'spawn':
                await this.mergeSettingsAndSpawn(ws, msg.config);
                break;
            case 'stop':
                await this.agentManager.stop(msg.processId);
                break;
            case 'message':
                await this.agentManager.sendMessage(msg.processId, msg.content);
                break;
            case 'delegate:message': {
                const delivery = msg.delivery;
                const content = String(msg.content ?? '').trim();
                const execId = typeof msg.execId === 'string' && msg.execId.trim()
                    ? msg.execId.trim()
                    : typeof msg.processId === 'string'
                        ? msg.processId
                        : '';
                if (!execId) {
                    throw new Error('processId or execId is required');
                }
                if (!content) {
                    throw new Error('content is required');
                }
                if (delivery !== 'inject' && delivery !== 'after_complete') {
                    throw new Error('delivery must be inject or after_complete');
                }
                this.delegateMessage({
                    execId,
                    message: content,
                    delivery,
                    requestedBy: 'dashboard:ws:delegate_message',
                });
                break;
            }
            case 'approve':
                await this.agentManager.respondApproval({
                    id: msg.requestId,
                    processId: msg.processId,
                    allow: msg.allow,
                });
                break;
            case 'cli:spawned': {
                const proc = msg.process;
                this.agentManager.registerCliProcess(proc);
                this.eventBus.emit('agent:spawned', proc);
                if (proc.config?.prompt) {
                    const userEntry = EntryNormalizer.userMessage(proc.id, proc.config.prompt);
                    this.agentManager.addCliEntry(proc.id, userEntry);
                    this.eventBus.emit('agent:entry', userEntry);
                }
                break;
            }
            case 'cli:entry': {
                const entry = msg.entry;
                this.agentManager.addCliEntry(entry.processId, entry);
                this.eventBus.emit('agent:entry', entry);
                break;
            }
            case 'cli:stopped':
                this.agentManager.updateCliProcessStatus(msg.processId, 'stopped');
                this.eventBus.emit('agent:stopped', { processId: msg.processId });
                break;
        }
    }
    /**
     * Merge saved agent settings into spawn config, then spawn.
     * Public so ExecutionWsHandler can reuse it for issue analyze/plan.
     */
    async mergeSettingsAndSpawn(ws, config) {
        const saved = await loadDashboardAgentSettings(this.workflowRoot, config.type);
        const mergedConfig = {
            ...config,
            model: (config.model ?? saved?.model) || undefined,
            approvalMode: config.approvalMode ?? saved?.approvalMode ?? undefined,
            baseUrl: (config.baseUrl ?? saved?.baseUrl) || undefined,
            apiKey: (config.apiKey ?? saved?.apiKey) || undefined,
            settingsFile: (config.settingsFile ?? saved?.settingsFile) || undefined,
            envFile: (config.envFile ?? saved?.envFile) || undefined,
        };
        // Inject MCP config if agent is being added to a meeting room
        const roomSessionId = mergedConfig.metadata?.roomSessionId;
        const roomRole = mergedConfig.metadata?.roomRole;
        if (roomSessionId && roomRole && this.roomSessionManager) {
            const session = this.roomSessionManager.getSession(roomSessionId);
            if (session) {
                // Ensure MCP TCP server is running (idempotent)
                await session.startMcp();
                const projectRoot = resolve(this.workflowRoot, '..');
                // Inject MCP config based on agent type
                const MCP_AGENT_TYPES = {
                    'claude-code': 'claude-code',
                    'agent-sdk': 'agent-sdk',
                    'codex': 'codex',
                };
                const mcpAgentType = MCP_AGENT_TYPES[mergedConfig.type];
                if (mcpAgentType) {
                    if (mcpAgentType === 'claude-code') {
                        // Use HTTP transport — Claude Code --print mode doesn't connect
                        // stdio MCP servers (stays "pending" forever). HTTP servers connect
                        // immediately since the dashboard HTTP server is already running.
                        const mcpInfo = session.getMcpInfo();
                        const httpUrl = `http://127.0.0.1:3001/api/rooms/${roomSessionId}/mcp?token=${mcpInfo?.token ?? ''}&agentId=${roomRole}`;
                        const mcpJsonPath = join(projectRoot, '.mcp.json');
                        try {
                            const existing = existsSync(mcpJsonPath)
                                ? JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))
                                : { mcpServers: {} };
                            existing.mcpServers['meeting-room'] = {
                                type: 'http',
                                url: httpUrl,
                            };
                            writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2));
                        }
                        catch {
                            // Fallback to --mcp-config tmp file
                            const tmpPath = join(tmpdir(), `mr-mcp-${roomSessionId}-${roomRole}.json`);
                            writeFileSync(tmpPath, JSON.stringify({
                                mcpServers: { 'meeting-room': { type: 'http', url: httpUrl } },
                            }));
                            mergedConfig.mcpConfigPath = tmpPath;
                        }
                    }
                    else if (mcpAgentType === 'agent-sdk') {
                        const mcpServer = session.getMcpConfig('agent-sdk', roomRole);
                        mergedConfig.metadata = { ...mergedConfig.metadata, roomMcpServer: mcpServer };
                    }
                    // codex uses stdio config via env vars (handled by adapter)
                }
                // Claude Code in room → force interactive mode for follow-up wake messages
                // Also set workDir to project root so it finds .mcp.json
                if (mergedConfig.type === 'claude-code') {
                    mergedConfig.interactive = true;
                    mergedConfig.workDir = projectRoot;
                }
                // Leader → auto bypass permissions (needs free MCP tool access)
                if (roomRole === 'leader') {
                    mergedConfig.approvalMode = mergedConfig.approvalMode ?? 'auto';
                }
            }
        }
        const proc = await this.agentManager.spawn(mergedConfig.type, mergedConfig);
        // Auto-link to meeting room if metadata contains room context
        if (roomSessionId && roomRole && this.roomSessionManager) {
            const session = this.roomSessionManager.getSession(roomSessionId);
            if (session) {
                const agent = session.addAgent(roomRole, proc.id);
                this.eventBus.emit('room:agent_joined', { sessionId: roomSessionId, agent });
            }
        }
        const response = {
            type: 'agent:spawned',
            data: proc,
            timestamp: new Date().toISOString(),
        };
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response));
        }
    }
}
//# sourceMappingURL=agent-handler.js.map