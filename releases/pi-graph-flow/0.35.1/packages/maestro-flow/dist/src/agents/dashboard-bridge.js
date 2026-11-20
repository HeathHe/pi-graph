// ---------------------------------------------------------------------------
// DashboardBridge — optional WS client for forwarding CLI agent events to
// a running Dashboard instance. Fails silently when Dashboard is unavailable.
// ---------------------------------------------------------------------------
import { WebSocket } from 'ws';
// ---------------------------------------------------------------------------
// DashboardBridge
// ---------------------------------------------------------------------------
export class DashboardBridge {
    ws = null;
    activeCount = 0;
    /**
     * Attempt to connect to the Dashboard WS endpoint.
     * Returns immediately if connection fails or times out.
     */
    async tryConnect(url, timeoutMs = 1000) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                ws.terminate();
                resolve(false);
            }, timeoutMs);
            const ws = new WebSocket(url);
            ws.on('open', () => {
                clearTimeout(timer);
                this.ws = ws;
                resolve(true);
            });
            ws.on('error', () => {
                clearTimeout(timer);
                resolve(false);
            });
        });
    }
    /** Forward a process spawn event to the Dashboard */
    forwardSpawn(process) {
        this.send({ action: 'cli:spawned', process });
    }
    /** Forward a normalized entry to the Dashboard */
    forwardEntry(entry) {
        this.send({ action: 'cli:entry', entry });
    }
    /** Register an active CLI process for reference counting */
    registerProcess() {
        this.activeCount++;
    }
    /** Notify Dashboard that the CLI process has stopped */
    forwardStopped(processId) {
        this.send({ action: 'cli:stopped', processId });
        this.activeCount--;
    }
    /** Close the WS connection only when no active processes remain */
    closeIfIdle() {
        if (this.activeCount <= 0) {
            this.close();
        }
    }
    /** Close the WS connection */
    close() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
        this.ws = null;
        this.activeCount = 0;
    }
    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(data));
            }
            catch {
                // Silent failure — dashboard monitoring is best-effort
            }
        }
    }
}
//# sourceMappingURL=dashboard-bridge.js.map