// ---------------------------------------------------------------------------
// Terminal Adapter — wraps TerminalBackend into AdapterLike interface
// with 2s polling output collection and 120s stale timeout.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const POLL_INTERVAL_MS = 2000;
const MAX_STALE_CYCLES = 60; // 60 * 2s = 120s stale timeout
const STARTUP_DELAY_MS = 1000;
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
export class TerminalAdapter {
    backend;
    toolCmd;
    panes = new Map();
    listeners = new Map();
    constructor(backend, toolCmd) {
        this.backend = backend;
        this.toolCmd = toolCmd;
    }
    async spawn(config) {
        const processId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        // Create pane with the CLI tool running
        const paneId = await this.backend.createPane({
            cwd: config.workDir,
            cmd: this.toolCmd,
        });
        this.panes.set(processId, { paneId, polling: true });
        // Wait for tool to start, then inject prompt
        await sleep(STARTUP_DELAY_MS);
        await this.backend.sendText(paneId, config.prompt);
        // Start polling for output (fire-and-forget async loop)
        this.pollOutput(processId, paneId);
        return {
            id: processId,
            type: config.type,
            status: 'running',
            config,
            startedAt: new Date().toISOString(),
        };
    }
    async stop(processId) {
        const pane = this.panes.get(processId);
        if (!pane)
            return;
        pane.polling = false;
        await this.backend.killPane(pane.paneId);
        this.panes.delete(processId);
        this.emit(processId, {
            id: `${processId}-stop`,
            processId,
            timestamp: new Date().toISOString(),
            type: 'status_change',
            status: 'stopped',
            reason: 'manual stop',
        });
    }
    onEntry(processId, cb) {
        if (!this.listeners.has(processId)) {
            this.listeners.set(processId, new Set());
        }
        this.listeners.get(processId).add(cb);
        return () => {
            this.listeners.get(processId)?.delete(cb);
        };
    }
    // -------------------------------------------------------------------------
    // Polling loop — getText diff every 2s, 120s stale timeout
    // -------------------------------------------------------------------------
    async pollOutput(processId, paneId) {
        let lastContent = '';
        let staleCount = 0;
        while (this.panes.get(processId)?.polling) {
            await sleep(POLL_INTERVAL_MS);
            // Check if pane is still alive
            const alive = await this.backend.isAlive(paneId);
            if (!alive) {
                this.emit(processId, {
                    id: `${processId}-done`,
                    processId,
                    timestamp: new Date().toISOString(),
                    type: 'status_change',
                    status: 'stopped',
                    reason: 'pane exited',
                });
                this.panes.delete(processId);
                break;
            }
            // Capture pane content and diff against previous snapshot
            const content = await this.backend.getText(paneId, 100);
            if (content !== lastContent) {
                const newContent = content.slice(lastContent.length);
                if (newContent.trim()) {
                    this.emit(processId, {
                        id: `${processId}-${Date.now()}`,
                        processId,
                        timestamp: new Date().toISOString(),
                        type: 'assistant_message',
                        content: newContent,
                        partial: true,
                    });
                }
                lastContent = content;
                staleCount = 0;
            }
            else {
                staleCount++;
                if (staleCount >= MAX_STALE_CYCLES) {
                    this.emit(processId, {
                        id: `${processId}-timeout`,
                        processId,
                        timestamp: new Date().toISOString(),
                        type: 'status_change',
                        status: 'stopped',
                        reason: 'output stale timeout (120s)',
                    });
                    this.panes.delete(processId);
                    break;
                }
            }
        }
    }
    emit(processId, entry) {
        const cbs = this.listeners.get(processId);
        if (cbs) {
            cbs.forEach(cb => cb(entry));
        }
    }
}
//# sourceMappingURL=terminal-adapter.js.map