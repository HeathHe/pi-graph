import type { WebSocket } from 'ws';
export declare class SessionScopedEventFilter {
    /** Map of WebSocket client -> set of subscribed session IDs */
    private readonly subscriptions;
    /** Subscribe a client to a specific room session */
    subscribe(ws: WebSocket, sessionId: string): void;
    /** Unsubscribe a client from a specific room session */
    unsubscribe(ws: WebSocket, sessionId: string): void;
    /** Check if a client is subscribed to a specific room session */
    isSubscribed(ws: WebSocket, sessionId: string): boolean;
    /** Remove all subscriptions for a client (called on disconnect) */
    unsubscribeAll(ws: WebSocket): void;
}
