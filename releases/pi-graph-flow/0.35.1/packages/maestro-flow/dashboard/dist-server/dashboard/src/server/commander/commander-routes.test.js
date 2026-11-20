import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createCommanderRoutes } from './commander-routes.js';
import { DEFAULT_COMMANDER_CONFIG } from '../../shared/commander-types.js';
// ---------------------------------------------------------------------------
// Mock CommanderAgent
// ---------------------------------------------------------------------------
function createMockCommanderAgent() {
    const state = {
        status: 'idle',
        lastTickAt: '',
        lastDecision: null,
        activeWorkers: 0,
        sessionId: 'test-session',
        tickCount: 0,
    };
    return {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        getState: vi.fn().mockReturnValue(state),
        getConfig: vi.fn().mockReturnValue({ ...DEFAULT_COMMANDER_CONFIG }),
        updateConfig: vi.fn(),
    };
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Commander Routes', () => {
    function createApp() {
        const agent = createMockCommanderAgent();
        const routes = createCommanderRoutes(agent);
        const app = new Hono();
        app.route('/', routes);
        return { app, agent };
    }
    // --- test_commander_routes_start ---
    describe('POST /api/commander/start', () => {
        it('calls commanderAgent.start() and returns state', async () => {
            const { app, agent } = createApp();
            const res = await app.request('/api/commander/start', { method: 'POST' });
            const body = await res.json();
            expect(res.status).toBe(200);
            expect(body.ok).toBe(true);
            expect(body.state).toBeDefined();
            expect(agent.start).toHaveBeenCalledOnce();
        });
        it('returns 500 on start failure', async () => {
            const { app, agent } = createApp();
            agent.start.mockRejectedValueOnce(new Error('Config load failed'));
            const res = await app.request('/api/commander/start', { method: 'POST' });
            const body = await res.json();
            expect(res.status).toBe(500);
            expect(body.error).toBe('Config load failed');
        });
    });
    // --- POST /api/commander/stop ---
    describe('POST /api/commander/stop', () => {
        it('calls commanderAgent.stop() and returns ok', async () => {
            const { app, agent } = createApp();
            const res = await app.request('/api/commander/stop', { method: 'POST' });
            const body = await res.json();
            expect(res.status).toBe(200);
            expect(body.ok).toBe(true);
            expect(agent.stop).toHaveBeenCalledOnce();
        });
    });
    // --- POST /api/commander/pause ---
    describe('POST /api/commander/pause', () => {
        it('calls pause when not paused', async () => {
            const { app, agent } = createApp();
            const res = await app.request('/api/commander/pause', { method: 'POST' });
            const body = await res.json();
            expect(res.status).toBe(200);
            expect(body.ok).toBe(true);
            expect(agent.pause).toHaveBeenCalledOnce();
        });
        it('calls resume when paused', async () => {
            const { app, agent } = createApp();
            agent.getState.mockReturnValueOnce({
                status: 'paused',
                lastTickAt: '',
                lastDecision: null,
                activeWorkers: 0,
                sessionId: 'test',
                tickCount: 0,
            });
            const res = await app.request('/api/commander/pause', { method: 'POST' });
            const body = await res.json();
            expect(res.status).toBe(200);
            expect(agent.resume).toHaveBeenCalledOnce();
        });
    });
    // --- test_commander_routes_status ---
    describe('GET /api/commander/status', () => {
        it('returns current state', async () => {
            const { app } = createApp();
            const res = await app.request('/api/commander/status');
            const body = await res.json();
            expect(res.status).toBe(200);
            expect(body.status).toBe('idle');
            expect(body.sessionId).toBe('test-session');
            expect(body.tickCount).toBe(0);
        });
    });
    // --- test_commander_routes_config_update ---
    describe('PUT /api/commander/config', () => {
        it('updates config and returns updated config', async () => {
            const { app, agent } = createApp();
            const res = await app.request('/api/commander/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ maxConcurrentWorkers: 5 }),
            });
            const body = await res.json();
            expect(res.status).toBe(200);
            expect(body.ok).toBe(true);
            expect(body.config).toBeDefined();
            expect(agent.updateConfig).toHaveBeenCalledWith({ maxConcurrentWorkers: 5 });
        });
        it('returns 500 on invalid body', async () => {
            const { app } = createApp();
            const res = await app.request('/api/commander/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: 'invalid json{{{',
            });
            expect(res.status).toBe(500);
        });
    });
    // --- POST /api/commander/stop error handling ---
    describe('POST /api/commander/stop — error paths', () => {
        it('returns 500 when stop throws', async () => {
            const { app, agent } = createApp();
            agent.stop.mockImplementationOnce(() => {
                throw new Error('Timer cleanup failed');
            });
            const res = await app.request('/api/commander/stop', { method: 'POST' });
            const body = await res.json();
            expect(res.status).toBe(500);
            expect(body.error).toBe('Timer cleanup failed');
        });
    });
    // --- POST /api/commander/pause error handling ---
    describe('POST /api/commander/pause — error paths', () => {
        it('returns 500 when pause throws', async () => {
            const { app, agent } = createApp();
            agent.pause.mockImplementationOnce(() => {
                throw new Error('Cannot pause in current state');
            });
            const res = await app.request('/api/commander/pause', { method: 'POST' });
            const body = await res.json();
            expect(res.status).toBe(500);
            expect(body.error).toBe('Cannot pause in current state');
        });
        it('returns 500 when resume throws', async () => {
            const { app, agent } = createApp();
            agent.getState.mockReturnValueOnce({
                status: 'paused',
                lastTickAt: '',
                lastDecision: null,
                activeWorkers: 0,
                sessionId: 'test',
                tickCount: 0,
            });
            agent.resume.mockImplementationOnce(() => {
                throw new Error('Resume failed');
            });
            const res = await app.request('/api/commander/pause', { method: 'POST' });
            const body = await res.json();
            expect(res.status).toBe(500);
            expect(body.error).toBe('Resume failed');
        });
    });
});
//# sourceMappingURL=commander-routes.test.js.map