import type { DashboardEventBus } from '../state/event-bus.js';
export declare class SSEHub {
    private readonly eventBus;
    private readonly clients;
    private readonly maxConnections;
    private readonly heartbeatMs;
    private heartbeatTimer;
    private nextId;
    private readonly eventListener;
    constructor(eventBus: DashboardEventBus, options?: {
        maxConnections?: number;
        heartbeatMs?: number;
    });
    /**
     * Check if a new client can be accepted.
     * Returns false when max connections is reached.
     */
    canAccept(): boolean;
    /**
     * Register a new SSE client.
     * Returns the client ID for later removal, or null if max connections reached.
     */
    addClient(write: (chunk: string) => void, close: () => void): string | null;
    /** Unregister a client by ID */
    removeClient(id: string): void;
    /** Return the number of connected clients */
    getClientCount(): number;
    /** Send a named SSE event to all connected clients */
    broadcast(eventType: string, data: unknown): void;
    /** Stop heartbeat and unsubscribe from EventBus */
    destroy(): void;
    private startHeartbeat;
}
