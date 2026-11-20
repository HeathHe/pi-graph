// ---------------------------------------------------------------------------
// Execution REST API routes — dispatch, cancel, status, supervisor control
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
const VALID_EXECUTORS = new Set([
    'claude-code', 'codex', 'codex-server', 'gemini', 'gemini-a2a', 'qwen', 'opencode', 'agent-sdk', 'pi', 'grok',
]);
/**
 * Execution routes following the Hono factory pattern.
 *
 * POST   /api/execution/dispatch       { issueId, executor? }
 * POST   /api/execution/batch          { issueIds, executor?, maxConcurrency? }
 * POST   /api/execution/cancel/:id     cancel running/queued issue
 * GET    /api/execution/status         supervisor status snapshot
 * PUT    /api/execution/supervisor     { enabled, config? }
 */
export function createExecutionRoutes(scheduler) {
    const app = new Hono();
    // POST /api/execution/dispatch — dispatch single issue
    app.post('/api/execution/dispatch', async (c) => {
        try {
            const body = await c.req.json();
            const issueId = body.issueId;
            if (!issueId || typeof issueId !== 'string') {
                return c.json({ error: 'Missing or invalid "issueId" (must be string)' }, 400);
            }
            const executor = body.executor;
            if (executor !== undefined && !VALID_EXECUTORS.has(executor)) {
                return c.json({ error: `Invalid "executor": ${executor}` }, 400);
            }
            await scheduler.executeIssue(issueId, executor);
            return c.json({ ok: true, issueId });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 500);
        }
    });
    // POST /api/execution/batch — dispatch multiple issues
    app.post('/api/execution/batch', async (c) => {
        try {
            const body = await c.req.json();
            const issueIds = body.issueIds;
            if (!Array.isArray(issueIds) || issueIds.length === 0 || !issueIds.every((id) => typeof id === 'string')) {
                return c.json({ error: 'Missing or invalid "issueIds" (must be non-empty string array)' }, 400);
            }
            const executor = body.executor;
            if (executor !== undefined && !VALID_EXECUTORS.has(executor)) {
                return c.json({ error: `Invalid "executor": ${executor}` }, 400);
            }
            const maxConcurrency = body.maxConcurrency;
            if (maxConcurrency !== undefined && (typeof maxConcurrency !== 'number' || maxConcurrency < 1)) {
                return c.json({ error: '"maxConcurrency" must be a positive number' }, 400);
            }
            await scheduler.executeBatch(issueIds, executor, maxConcurrency);
            return c.json({ ok: true, count: issueIds.length });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 500);
        }
    });
    // POST /api/execution/cancel/:id — cancel a running/queued issue
    app.post('/api/execution/cancel/:id', async (c) => {
        try {
            const id = c.req.param('id');
            await scheduler.cancelIssue(id);
            return c.json({ ok: true });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 500);
        }
    });
    // GET /api/execution/status — supervisor status snapshot
    app.get('/api/execution/status', (c) => {
        return c.json(scheduler.getStatus());
    });
    // PUT /api/execution/supervisor — toggle supervisor on/off + config
    app.put('/api/execution/supervisor', async (c) => {
        try {
            const body = await c.req.json();
            const enabled = body.enabled;
            const config = body.config;
            if (config) {
                scheduler.updateConfig(config);
            }
            if (enabled === true) {
                scheduler.startSupervisor();
            }
            else if (enabled === false) {
                scheduler.stopSupervisor();
            }
            return c.json({ ok: true, status: scheduler.getStatus() });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 500);
        }
    });
    return app;
}
//# sourceMappingURL=execution.js.map