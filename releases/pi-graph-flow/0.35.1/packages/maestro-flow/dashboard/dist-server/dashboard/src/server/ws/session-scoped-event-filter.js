// ---------------------------------------------------------------------------
// SessionScopedEventFilter — tracks which room sessions each WS client
// subscribes to, so room:* events are only sent to interested clients.
// ---------------------------------------------------------------------------
export class SessionScopedEventFilter {
    /** Map of WebSocket client -> set of subscribed session IDs */
    subscriptions = new Map();
    /** Subscribe a client to a specific room session */
    subscribe(ws, sessionId) {
        let sessions = this.subscriptions.get(ws);
        if (!sessions) {
            sessions = new Set();
            this.subscriptions.set(ws, sessions);
        }
        sessions.add(sessionId);
    }
    /** Unsubscribe a client from a specific room session */
    unsubscribe(ws, sessionId) {
        const sessions = this.subscriptions.get(ws);
        if (!sessions)
            return;
        sessions.delete(sessionId);
        if (sessions.size === 0) {
            this.subscriptions.delete(ws);
        }
    }
    /** Check if a client is subscribed to a specific room session */
    isSubscribed(ws, sessionId) {
        const sessions = this.subscriptions.get(ws);
        return sessions !== undefined && sessions.has(sessionId);
    }
    /** Remove all subscriptions for a client (called on disconnect) */
    unsubscribeAll(ws) {
        this.subscriptions.delete(ws);
    }
}
//# sourceMappingURL=session-scoped-event-filter.js.map