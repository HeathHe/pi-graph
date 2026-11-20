// ---------------------------------------------------------------------------
// AgentSdkAdapter — bridges @anthropic-ai/claude-agent-sdk to BaseAgentAdapter
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { BaseAgentAdapter } from './base-adapter.js';
import { EntryNormalizer } from './entry-normalizer.js';
import { SdkMessageTranslator } from './sdk-message-translator.js';
import { createIssueMcpServer } from './tools/issue-mcp-server.js';
/** Auto-deny timeout for pending approvals (5 minutes) */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------
export class AgentSdkAdapter extends BaseAgentAdapter {
    agentType = 'agent-sdk';
    abortControllers = new Map();
    pendingApprovals = new Map();
    issueMcpServerPromise;
    constructor(workflowRoot) {
        super();
        this.issueMcpServerPromise = workflowRoot ? createIssueMcpServer(workflowRoot) : null;
    }
    // --- Lifecycle hooks -----------------------------------------------------
    async doSpawn(processId, config) {
        const abortController = new AbortController();
        this.abortControllers.set(processId, abortController);
        const agentProcess = {
            id: processId,
            type: 'agent-sdk',
            status: 'spawning',
            config,
            startedAt: new Date().toISOString(),
            interactive: false,
        };
        // Fire-and-forget the SDK query — errors are handled inside
        this.runAgentQuery(processId, config, abortController).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            this.emitEntry(processId, EntryNormalizer.error(processId, message, 'sdk_error'));
            this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'error', message));
            const proc = this.getProcess(processId);
            if (proc) {
                proc.status = 'error';
            }
        });
        return agentProcess;
    }
    async doStop(processId) {
        // Update status
        const proc = this.getProcess(processId);
        if (proc) {
            proc.status = 'stopping';
            this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'stopping', 'User requested stop'));
        }
        // Abort the SDK query
        const controller = this.abortControllers.get(processId);
        if (controller) {
            controller.abort();
        }
        // Deny all pending approvals for this process
        this.denyAllPendingApprovals(processId);
        // Cleanup
        this.abortControllers.delete(processId);
    }
    async doSendMessage(_processId, _content) {
        throw new Error('AgentSdkAdapter does not support interactive messages');
    }
    async doRespondApproval(decision) {
        const pending = this.pendingApprovals.get(decision.id);
        if (!pending) {
            throw new Error(`No pending approval found with id: ${decision.id}`);
        }
        // Clear the timeout
        clearTimeout(pending.timeoutId);
        // Build the permission result
        const result = decision.allow
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: 'User denied permission' };
        // Resolve the promise to unblock the SDK
        pending.resolve(result);
        // Emit approval response entry
        this.emitEntry(decision.processId, EntryNormalizer.approvalResponse(decision.processId, decision.id, decision.allow));
        // Cleanup
        this.pendingApprovals.delete(decision.id);
    }
    // --- Private: SDK query execution ----------------------------------------
    async runAgentQuery(processId, config, abortController) {
        const translator = new SdkMessageTranslator(processId);
        // Build SDK options
        const options = {
            abortController,
            cwd: config.workDir,
            model: config.model,
            settingSources: ['project'],
        };
        // When settingsFile is set, use settings file path and dontAsk mode
        if (config.settingsFile) {
            options.settings = config.settingsFile;
            options.permissionMode = 'dontAsk';
        }
        else {
            // Existing env-based behavior
            if (config.env || config.baseUrl || config.apiKey) {
                options.env = { ...process.env, ...config.env };
            }
            if (config.baseUrl) {
                options.env = options.env ?? { ...process.env };
                options.env.ANTHROPIC_BASE_URL = config.baseUrl;
            }
            if (config.apiKey) {
                options.env = options.env ?? { ...process.env };
                options.env.ANTHROPIC_API_KEY = config.apiKey;
            }
            // Set permission mode based on config
            const permissionMode = this.resolvePermissionMode(config);
            options.permissionMode = permissionMode;
            // If not bypassing permissions, install the canUseTool callback
            if (permissionMode !== 'bypassPermissions') {
                options.canUseTool = this.createCanUseToolCallback(processId);
            }
            else {
                options.allowDangerouslySkipPermissions = true;
            }
        }
        // Inject issue MCP server if available
        const issueMcp = this.issueMcpServerPromise ? await this.issueMcpServerPromise : null;
        if (issueMcp) {
            options.mcpServers = { 'issue-monitor': issueMcp };
        }
        // Inject room MCP server if agent is part of a meeting room
        const roomMcp = config.metadata?.roomMcpServer;
        if (roomMcp) {
            options.mcpServers = { ...options.mcpServers, 'meeting-room': roomMcp };
        }
        // Start the query
        const queryInstance = query({ prompt: config.prompt, options });
        // Update status to running
        const proc = this.getProcess(processId);
        if (proc) {
            proc.status = 'running';
        }
        this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'running'));
        // Iterate the async generator
        for await (const msg of queryInstance) {
            // Treat each message as a record for the translator
            const entries = translator.translate(msg);
            for (const entry of entries) {
                this.emitEntry(processId, entry);
            }
        }
        // Query completed normally
        const completedProc = this.getProcess(processId);
        if (completedProc && completedProc.status !== 'error' && completedProc.status !== 'stopping') {
            completedProc.status = 'stopped';
            this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'stopped', 'Query completed'));
        }
        // Cleanup
        this.abortControllers.delete(processId);
    }
    // --- Private: Permission handling ----------------------------------------
    createCanUseToolCallback(processId) {
        return async (toolName, input, cbOptions) => {
            return this.handleCanUseTool(processId, toolName, input, cbOptions.signal);
        };
    }
    handleCanUseTool(processId, toolName, toolInput, signal) {
        const requestId = randomUUID();
        return new Promise((resolve) => {
            // Auto-deny after timeout
            const timeoutId = setTimeout(() => {
                if (this.pendingApprovals.has(requestId)) {
                    this.pendingApprovals.delete(requestId);
                    this.emitEntry(processId, EntryNormalizer.approvalResponse(processId, requestId, false));
                    resolve({ behavior: 'deny', message: 'Approval timed out (5 minutes)' });
                }
            }, APPROVAL_TIMEOUT_MS);
            // Store the pending approval
            const pending = {
                requestId,
                processId,
                resolve,
                timeoutId,
            };
            this.pendingApprovals.set(requestId, pending);
            // Listen for abort to clean up
            const onAbort = () => {
                if (this.pendingApprovals.has(requestId)) {
                    clearTimeout(timeoutId);
                    this.pendingApprovals.delete(requestId);
                    resolve({ behavior: 'deny', message: 'Operation aborted' });
                }
            };
            signal.addEventListener('abort', onAbort, { once: true });
            // Emit the approval request entry
            this.emitEntry(processId, EntryNormalizer.approvalRequest(processId, toolName, toolInput, requestId));
            // Emit the approval event so listeners can present the UI
            const request = {
                id: requestId,
                processId,
                toolName,
                toolInput,
                timestamp: new Date().toISOString(),
            };
            this.emitApproval(processId, request);
        });
    }
    // --- Private: Helpers ----------------------------------------------------
    resolvePermissionMode(config) {
        if (config.approvalMode === 'auto') {
            return 'bypassPermissions';
        }
        return 'default';
    }
    denyAllPendingApprovals(processId) {
        for (const [id, pending] of this.pendingApprovals) {
            if (pending.processId === processId) {
                clearTimeout(pending.timeoutId);
                pending.resolve({ behavior: 'deny', message: 'Process stopped' });
                this.emitEntry(processId, EntryNormalizer.approvalResponse(processId, id, false));
                this.pendingApprovals.delete(id);
            }
        }
    }
}
//# sourceMappingURL=agent-sdk-adapter.js.map