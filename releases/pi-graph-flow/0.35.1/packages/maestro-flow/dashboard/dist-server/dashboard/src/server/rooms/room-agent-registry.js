// ---------------------------------------------------------------------------
// RoomAgentRegistry — agent lifecycle management with activeWakes guard
// ---------------------------------------------------------------------------
const DEFAULT_WAKE_TIMEOUT_MS = 5_000;
export class RoomAgentRegistry {
    agentManager;
    wakeTimeoutMs;
    agents = new Map();
    activeWakes = new Set(); // "sessionId:role" keys
    wakeTimeouts = new Map();
    constructor(agentManager, wakeTimeoutMs = DEFAULT_WAKE_TIMEOUT_MS) {
        this.agentManager = agentManager;
        this.wakeTimeoutMs = wakeTimeoutMs;
    }
    /** Register an agent in a session */
    register(sessionId, role, processId) {
        const now = new Date().toISOString();
        const agent = {
            role,
            processId,
            status: 'idle',
            joinedAt: now,
            lastActivityAt: now,
        };
        let list = this.agents.get(sessionId);
        if (!list) {
            list = [];
            this.agents.set(sessionId, list);
        }
        // Replace existing agent with same role if present
        const existingIdx = list.findIndex((a) => a.role === role);
        if (existingIdx !== -1) {
            list[existingIdx] = agent;
        }
        else {
            list.push(agent);
        }
        return agent;
    }
    /** Unregister an agent from a session */
    unregister(sessionId, role) {
        const list = this.agents.get(sessionId);
        if (!list)
            return false;
        const idx = list.findIndex((a) => a.role === role);
        if (idx === -1)
            return false;
        list.splice(idx, 1);
        // Clean up wake guard
        const wakeKey = `${sessionId}:${role}`;
        this.clearWakeGuard(wakeKey);
        return true;
    }
    /** Get all agents in a session */
    getAgents(sessionId) {
        return this.agents.get(sessionId) ?? [];
    }
    /** Get a specific agent by role in a session */
    getAgentByRole(sessionId, role) {
        const list = this.agents.get(sessionId);
        if (!list)
            return undefined;
        return list.find((a) => a.role === role);
    }
    /** Update agent status */
    setStatus(sessionId, role, status) {
        const agent = this.getAgentByRole(sessionId, role);
        if (!agent)
            return false;
        agent.status = status;
        agent.lastActivityAt = new Date().toISOString();
        return true;
    }
    /**
     * Wake an agent by sending a message to its process.
     * Uses an activeWakes guard set to prevent concurrent wake calls for the same agent.
     * Guard auto-clears after wakeTimeoutMs.
     */
    async wake(sessionId, role, message) {
        const agent = this.getAgentByRole(sessionId, role);
        if (!agent?.processId)
            return false;
        const wakeKey = `${sessionId}:${role}`;
        // Guard: prevent concurrent wakes for the same agent
        if (this.activeWakes.has(wakeKey)) {
            return false;
        }
        this.activeWakes.add(wakeKey);
        // Auto-clear guard after timeout
        const timer = setTimeout(() => {
            this.clearWakeGuard(wakeKey);
        }, this.wakeTimeoutMs);
        this.wakeTimeouts.set(wakeKey, timer);
        try {
            await this.agentManager.sendMessage(agent.processId, message);
            agent.lastActivityAt = new Date().toISOString();
            return true;
        }
        catch {
            // Clear guard on failure so retry is possible
            this.clearWakeGuard(wakeKey);
            return false;
        }
    }
    /** Clear all agents for a session */
    clear(sessionId) {
        const list = this.agents.get(sessionId);
        if (list) {
            for (const agent of list) {
                const wakeKey = `${sessionId}:${agent.role}`;
                this.clearWakeGuard(wakeKey);
            }
        }
        this.agents.delete(sessionId);
    }
    clearWakeGuard(wakeKey) {
        this.activeWakes.delete(wakeKey);
        const timer = this.wakeTimeouts.get(wakeKey);
        if (timer) {
            clearTimeout(timer);
            this.wakeTimeouts.delete(wakeKey);
        }
    }
}
//# sourceMappingURL=room-agent-registry.js.map