import { DEFAULT_CONFIG } from '../../shared/constants.js';
// ---------------------------------------------------------------------------
// SSEHub — manages connected SSE clients and broadcasts EventBus events
// ---------------------------------------------------------------------------
export class SSEHub {
    eventBus;
    clients = new Map();
    maxConnections;
    heartbeatMs;
    heartbeatTimer = null;
    nextId = 0;
    eventListener;
    constructor(eventBus, options) {
        this.eventBus = eventBus;
        this.maxConnections = options?.maxConnections ?? DEFAULT_CONFIG.sseMaxConnections;
        this.heartbeatMs = options?.heartbeatMs ?? DEFAULT_CONFIG.sseHeartbeatMs;
        // Subscribe to all EventBus events and broadcast to clients
        this.eventListener = (event) => {
            if (this.clients.size === 0)
                return;
            this.broadcast(event.type, event.data);
        };
        this.eventBus.onAny(this.eventListener);
        this.startHeartbeat();
    }
    /**
     * Check if a new client can be accepted.
     * Returns false when max connections is reached.
     */
    canAccept() {
        return this.clients.size < this.maxConnections;
    }
    /**
     * Register a new SSE client.
     * Returns the client ID for later removal, or null if max connections reached.
     */
    addClient(write, close) {
        if (!this.canAccept()) {
            return null;
        }
        const id = `sse-${++this.nextId}`;
        this.clients.set(id, { id, write, close });
        return id;
    }
    /** Unregister a client by ID */
    removeClient(id) {
        this.clients.delete(id);
    }
    /** Return the number of connected clients */
    getClientCount() {
        return this.clients.size;
    }
    /** Send a named SSE event to all connected clients */
    broadcast(eventType, data) {
        if (this.clients.size === 0)
            return;
        const payload = formatSSE(eventType, data);
        const toRemove = [];
        for (const [id, client] of this.clients) {
            try {
                client.write(payload);
            }
            catch {
                toRemove.push(id);
            }
        }
        // Clean up failed clients
        for (const id of toRemove) {
            this.clients.delete(id);
        }
    }
    /** Stop heartbeat and unsubscribe from EventBus */
    destroy() {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.eventBus.offAny(this.eventListener);
        this.clients.clear();
    }
    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------
    startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            if (this.clients.size === 0)
                return;
            const comment = ': heartbeat\n\n';
            const toRemove = [];
            for (const [id, client] of this.clients) {
                try {
                    client.write(comment);
                }
                catch {
                    toRemove.push(id);
                }
            }
            for (const id of toRemove) {
                this.clients.delete(id);
            }
        }, this.heartbeatMs);
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Format data as an SSE message: `event: <type>\ndata: <json>\n\n` */
function formatSSE(eventType, data) {
    const json = JSON.stringify(data);
    return `event: ${eventType}\ndata: ${json}\n\n`;
}
//# sourceMappingURL=sse-hub.js.map