// ---------------------------------------------------------------------------
// RoomSessionManager — manages all MeetingRoomSession instances
// ---------------------------------------------------------------------------
import { MeetingRoomSession } from './meeting-room-session.js';
export class RoomSessionManager {
    agentManager;
    eventBus;
    sessions = new Map();
    constructor(agentManager, eventBus) {
        this.agentManager = agentManager;
        this.eventBus = eventBus;
    }
    /** Create a new meeting room session */
    createSession(sessionId) {
        if (this.sessions.has(sessionId)) {
            throw new Error(`Room session already exists: ${sessionId}`);
        }
        const session = new MeetingRoomSession(sessionId, this.eventBus, this.agentManager);
        this.sessions.set(sessionId, session);
        return session;
    }
    /** Get an existing session by ID */
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    /** List all active session IDs */
    listSessions() {
        return Array.from(this.sessions.keys());
    }
    /** Destroy a specific session and clean up resources */
    async destroySession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return false;
        await session.destroy();
        this.sessions.delete(sessionId);
        return true;
    }
    /** Destroy all sessions — used during server shutdown */
    async destroyAll() {
        await Promise.allSettled(Array.from(this.sessions.values()).map((session) => session.destroy()));
        this.sessions.clear();
    }
}
//# sourceMappingURL=room-session-manager.js.map