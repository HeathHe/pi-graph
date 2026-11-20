import type { AgentManager } from '../agents/agent-manager.js';
import type { RoomAgent, RoomAgentStatus } from './room-types.js';
export declare class RoomAgentRegistry {
    private readonly agentManager;
    private readonly wakeTimeoutMs;
    private readonly agents;
    private readonly activeWakes;
    private readonly wakeTimeouts;
    constructor(agentManager: AgentManager, wakeTimeoutMs?: number);
    /** Register an agent in a session */
    register(sessionId: string, role: string, processId?: string): RoomAgent;
    /** Unregister an agent from a session */
    unregister(sessionId: string, role: string): boolean;
    /** Get all agents in a session */
    getAgents(sessionId: string): RoomAgent[];
    /** Get a specific agent by role in a session */
    getAgentByRole(sessionId: string, role: string): RoomAgent | undefined;
    /** Update agent status */
    setStatus(sessionId: string, role: string, status: RoomAgentStatus): boolean;
    /**
     * Wake an agent by sending a message to its process.
     * Uses an activeWakes guard set to prevent concurrent wake calls for the same agent.
     * Guard auto-clears after wakeTimeoutMs.
     */
    wake(sessionId: string, role: string, message: string): Promise<boolean>;
    /** Clear all agents for a session */
    clear(sessionId: string): void;
    private clearWakeGuard;
}
