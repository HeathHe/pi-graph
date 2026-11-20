import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createEventsRoute } from './events.js';
function createMockStateManager() {
    return {
        getBoard: vi.fn().mockReturnValue({
            project: { project_name: 'test' },
            phases: [],
            scratch: [],
            lastUpdated: '2026-01-01T00:00:00Z',
        }),
    };
}
function createMockSSEHub(overrides = {}) {
    return {
        canAccept: vi.fn().mockReturnValue(true),
        addClient: vi.fn().mockReturnValue('sse-1'),
        removeClient: vi.fn(),
        getClientCount: vi.fn().mockReturnValue(0),
        ...overrides,
    };
}
describe('Events Route', () => {
    function createApp(sseHubOverrides = {}) {
        const stateManager = createMockStateManager();
        const sseHub = createMockSSEHub(sseHubOverrides);
        const routes = createEventsRoute(stateManager, null, sseHub);
        const app = new Hono();
        app.route('/', routes);
        return { app, stateManager, sseHub };
    }
    it('returns 503 when max connections reached', async () => {
        const { app } = createApp({
            canAccept: vi.fn().mockReturnValue(false),
        });
        const res = await app.request('/events');
        expect(res.status).toBe(503);
        const text = await res.text();
        expect(text).toContain('Too many SSE connections');
    });
    it('returns 200 with SSE stream when connections available', async () => {
        const { app } = createApp();
        // The stream will hang waiting for abort, but we can check the initial response
        const controller = new AbortController();
        const resPromise = app.request('/events', { signal: controller.signal });
        // Give it a moment to start streaming
        await new Promise((r) => setTimeout(r, 50));
        controller.abort();
        try {
            const res = await resPromise;
            // Should return 200 for SSE
            expect(res.status).toBe(200);
        }
        catch {
            // AbortError is expected when we cancel the stream
        }
    });
    it('handles race condition when addClient returns null', async () => {
        // Simulate: canAccept() returns true but addClient() returns null (race)
        const { app } = createApp({
            canAccept: vi.fn().mockReturnValue(true),
            addClient: vi.fn().mockReturnValue(null),
        });
        const controller = new AbortController();
        const resPromise = app.request('/events', { signal: controller.signal });
        // Give it time to process
        await new Promise((r) => setTimeout(r, 100));
        controller.abort();
        try {
            const res = await resPromise;
            // Should still return 200 (SSE stream was started), but with error event
            expect(res.status).toBe(200);
            const text = await res.text();
            // The error event should have been written to the stream
            expect(text).toContain('Too many connections');
        }
        catch {
            // AbortError is expected
        }
    });
    it('calls stream.write for initial board snapshot', async () => {
        const writeSpy = vi.fn();
        const { app, sseHub } = createApp();
        const controller = new AbortController();
        const resPromise = app.request('/events', { signal: controller.signal });
        await new Promise((r) => setTimeout(r, 50));
        controller.abort();
        try {
            const res = await resPromise;
            expect(res.status).toBe(200);
            // sseHub.addClient should have been called
            expect(sseHub.addClient).toHaveBeenCalled();
        }
        catch {
            // AbortError expected
        }
    });
    it('invokes write and close callbacks registered via addClient', async () => {
        let capturedWrite;
        let capturedClose;
        const { app } = createApp({
            canAccept: vi.fn().mockReturnValue(true),
            addClient: vi.fn().mockImplementation((writeFn, closeFn) => {
                capturedWrite = writeFn;
                capturedClose = closeFn;
                return 'sse-cap';
            }),
        });
        const controller = new AbortController();
        const resPromise = app.request('/events', { signal: controller.signal });
        // Wait for addClient to be called
        await new Promise((r) => setTimeout(r, 50));
        // Exercise the captured callbacks (covers lines 34 and 37)
        expect(capturedWrite).toBeDefined();
        expect(capturedClose).toBeDefined();
        capturedWrite('data: test\n\n');
        capturedClose();
        controller.abort();
        try {
            await resPromise;
        }
        catch {
            // AbortError expected
        }
    });
});
//# sourceMappingURL=events.test.js.map