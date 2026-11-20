import { WebSocketServer, WebSocket } from 'ws';
// ---------------------------------------------------------------------------
// WebSocketManager — manages WS clients, bridges EventBus to WS broadcast
// ---------------------------------------------------------------------------
export class WebSocketManager {
    eventBus;
    sessionFilter;
    wss;
    clients = new Set();
    eventListener;
    routingTable = new Map();
    constructor(eventBus, handlers, sessionFilter) {
        this.eventBus = eventBus;
        this.sessionFilter = sessionFilter;
        // Build routing table from handlers
        for (const handler of handlers) {
            for (const action of handler.actions) {
                this.routingTable.set(action, handler);
            }
        }
        this.wss = new WebSocketServer({ noServer: true });
        // Subscribe to all EventBus events and broadcast as WsServerMessage.
        // Session-scoped room events are only sent to subscribed clients;
        // lifecycle events (room:created, room:closed) and all non-room events
        // continue broadcasting to every connected client.
        this.eventListener = (event) => {
            if (this.sessionFilter &&
                event.type.startsWith('room:') &&
                event.type !== 'room:created' &&
                event.type !== 'room:closed') {
                const payload = event.data;
                const sessionId = payload?.sessionId;
                if (sessionId) {
                    this.broadcastToSubscribed(event.type, event.data, sessionId);
                    return;
                }
            }
            this.broadcast(event.type, event.data);
        };
        this.eventBus.onAny(this.eventListener);
        // Handle new connections
        this.wss.on('connection', (ws) => {
            this.clients.add(ws);
            // Send initial connected message
            const connectedMsg = {
                type: 'connected',
                data: null,
                timestamp: new Date().toISOString(),
            };
            ws.send(JSON.stringify(connectedMsg));
            // Handle incoming messages from client
            ws.on('message', (raw) => {
                try {
                    const text = raw.toString();
                    const msg = JSON.parse(text);
                    this.handleClientMessage(ws, msg);
                }
                catch {
                    console.warn('[WS] Failed to parse client message');
                }
            });
            // Clean up on close
            ws.on('close', () => {
                this.clients.delete(ws);
                this.sessionFilter?.unsubscribeAll(ws);
            });
            ws.on('error', () => {
                this.clients.delete(ws);
                this.sessionFilter?.unsubscribeAll(ws);
            });
        });
    }
    /**
     * Handle HTTP upgrade request — call from server 'upgrade' event.
     */
    handleUpgrade(request, socket, head) {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.wss.emit('connection', ws, request);
        });
    }
    /**
     * Broadcast a typed message to all connected WS clients.
     */
    broadcast(type, data) {
        if (this.clients.size === 0)
            return;
        const msg = {
            type,
            data,
            timestamp: new Date().toISOString(),
        };
        const payload = JSON.stringify(msg);
        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        }
    }
    /**
     * Broadcast a session-scoped message only to clients subscribed to that session.
     */
    broadcastToSubscribed(type, data, sessionId) {
        if (this.clients.size === 0 || !this.sessionFilter)
            return;
        const msg = {
            type,
            data,
            timestamp: new Date().toISOString(),
        };
        const payload = JSON.stringify(msg);
        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN &&
                this.sessionFilter.isSubscribed(client, sessionId)) {
                client.send(payload);
            }
        }
    }
    /**
     * Send an error response back to the originating client.
     */
    sendError(ws, action, error) {
        if (ws.readyState !== WebSocket.OPEN)
            return;
        const msg = {
            type: 'agent:status',
            data: { action, error },
            timestamp: new Date().toISOString(),
        };
        ws.send(JSON.stringify(msg));
    }
    /**
     * Dispatch client messages — lookup handler from routing table and delegate.
     */
    handleClientMessage(ws, msg) {
        const handler = this.routingTable.get(msg.action);
        if (!handler) {
            console.log(`[WS] Unknown client action: ${msg.action}`);
            return;
        }
        handler
            .handle(msg.action, msg, ws, (type, data) => this.broadcast(type, data))
            .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            this.sendError(ws, msg.action, message);
        });
    }
    /** Return the number of connected clients */
    getClientCount() {
        return this.clients.size;
    }
    /** Close all clients, unsubscribe from EventBus, close WebSocketServer */
    destroy() {
        this.eventBus.offAny(this.eventListener);
        for (const client of this.clients) {
            client.close();
        }
        this.clients.clear();
        this.wss.close();
    }
}
//# sourceMappingURL=ws-manager.js.map