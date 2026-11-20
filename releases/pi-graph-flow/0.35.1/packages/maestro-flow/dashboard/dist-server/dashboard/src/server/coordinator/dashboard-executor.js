// ---------------------------------------------------------------------------
// DashboardExecutor — CommandExecutor implementation for the Dashboard.
// Bridges the Graph Coordinator's ExecuteRequest/ExecuteResult interface
// to the Dashboard's AgentManager spawn/stop lifecycle.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// DashboardExecutor
// ---------------------------------------------------------------------------
export class DashboardExecutor {
    agentManager;
    eventBus;
    activeProcessId = null;
    constructor(agentManager, eventBus) {
        this.agentManager = agentManager;
        this.eventBus = eventBus;
    }
    async execute(request) {
        const startTime = Date.now();
        try {
            const agentType = request.agent_type;
            const proc = await this.agentManager.spawn(agentType, {
                type: agentType,
                prompt: request.prompt,
                workDir: request.work_dir,
                approvalMode: request.approval_mode,
            });
            this.activeProcessId = proc.id;
            // Wait for the agent to stop (completed or errored)
            const reason = await this.waitForStopped(proc.id, request.timeout_ms);
            this.activeProcessId = null;
            const output = this.collectOutput(proc.id);
            const durationMs = Date.now() - startTime;
            return {
                success: !reason?.startsWith('error'),
                raw_output: output,
                exec_id: proc.id,
                duration_ms: durationMs,
                process_id: proc.id,
            };
        }
        catch (err) {
            this.activeProcessId = null;
            return {
                success: false,
                raw_output: err instanceof Error ? err.message : String(err),
                exec_id: '',
                duration_ms: Date.now() - startTime,
            };
        }
    }
    async abort() {
        if (!this.activeProcessId)
            return;
        try {
            await this.agentManager.stop(this.activeProcessId);
        }
        catch { /* Agent may have already stopped */ }
        this.activeProcessId = null;
    }
    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------
    waitForStopped(processId, timeoutMs) {
        return new Promise((resolve, reject) => {
            let timer = null;
            const handler = (event) => {
                const payload = event.data;
                if (payload.processId !== processId)
                    return;
                cleanup();
                resolve(payload.reason);
            };
            const cleanup = () => {
                this.eventBus.off('agent:stopped', handler);
                if (timer)
                    clearTimeout(timer);
            };
            this.eventBus.on('agent:stopped', handler);
            timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Agent timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });
    }
    collectOutput(processId) {
        const entries = this.agentManager.getEntries(processId);
        const parts = [];
        for (const entry of entries) {
            if (entry.type === 'assistant_message') {
                const msg = entry;
                parts.push(msg.content ?? msg.message ?? '');
            }
        }
        const joined = parts.join('\n');
        return joined.length > 50_000 ? joined.slice(-50_000) : joined;
    }
}
//# sourceMappingURL=dashboard-executor.js.map