import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WsEventType } from '../../shared/ws-protocol.js';
import type { DashboardEventBus } from '../state/event-bus.js';
import type { WsHandler } from './ws-handler.js';
import type { SessionScopedEventFilter } from './session-scoped-event-filter.js';
export declare class WebSocketManager {
    private readonly eventBus;
    private readonly sessionFilter?;
    private readonly wss;
    private readonly clients;
    private readonly eventListener;
    private readonly routingTable;
    constructor(eventBus: DashboardEventBus, handlers: WsHandler[], sessionFilter?: SessionScopedEventFilter | undefined);
    /**
     * Handle HTTP upgrade request — call from server 'upgrade' event.
     */
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
    /**
     * Broadcast a typed message to all connected WS clients.
     */
    broadcast(type: WsEventType, data: unknown): void;
    /**
     * Broadcast a session-scoped message only to clients subscribed to that session.
     */
    private broadcastToSubscribed;
    /**
     * Send an error response back to the originating client.
     */
    private sendError;
    /**
     * Dispatch client messages — lookup handler from routing table and delegate.
     */
    private handleClientMessage;
    /** Return the number of connected clients */
    getClientCount(): number;
    /** Close all clients, unsubscribe from EventBus, close WebSocketServer */
    destroy(): void;
}
