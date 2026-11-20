import type { AgentManager } from '../agents/agent-manager.js';
import type { DashboardEventBus } from '../state/event-bus.js';
import { MeetingRoomSession } from './meeting-room-session.js';
export declare class RoomSessionManager {
    private readonly agentManager;
    private readonly eventBus;
    private readonly sessions;
    constructor(agentManager: AgentManager, eventBus: DashboardEventBus);
    /** Create a new meeting room session */
    createSession(sessionId: string): MeetingRoomSession;
    /** Get an existing session by ID */
    getSession(sessionId: string): MeetingRoomSession | undefined;
    /** List all active session IDs */
    listSessions(): string[];
    /** Destroy a specific session and clean up resources */
    destroySession(sessionId: string): Promise<boolean>;
    /** Destroy all sessions — used during server shutdown */
    destroyAll(): Promise<void>;
}
