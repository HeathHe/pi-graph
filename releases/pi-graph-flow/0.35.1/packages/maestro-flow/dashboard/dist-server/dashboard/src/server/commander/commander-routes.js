// ---------------------------------------------------------------------------
// Commander REST API routes — start, stop, pause, status, config
// ---------------------------------------------------------------------------
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
/**
 * Commander routes following the Hono factory pattern.
 *
 * POST  /api/commander/start   start the commander tick loop
 * POST  /api/commander/stop    stop the commander tick loop
 * POST  /api/commander/pause   pause/resume the commander
 * GET   /api/commander/status  current commander state
 * PUT   /api/commander/config  update commander config
 */
export function createCommanderRoutes(commanderAgent, workflowRoot) {
    const app = new Hono();
    // POST /api/commander/start — start the commander tick loop
    app.post('/api/commander/start', async (c) => {
        try {
            await commanderAgent.start();
            return c.json({ ok: true, state: commanderAgent.getState() });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 500);
        }
    });
    // POST /api/commander/stop — stop the commander tick loop
    app.post('/api/commander/stop', (c) => {
        try {
            commanderAgent.stop();
            return c.json({ ok: true });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 500);
        }
    });
    // POST /api/commander/pause — toggle pause/resume
    app.post('/api/commander/pause', (c) => {
        try {
            const state = commanderAgent.getState();
            if (state.status === 'paused') {
                commanderAgent.resume();
            }
            else {
                commanderAgent.pause();
            }
            return c.json({ ok: true, state: commanderAgent.getState() });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 500);
        }
    });
    // GET /api/commander/status — current state snapshot
    app.get('/api/commander/status', (c) => {
        return c.json(commanderAgent.getState());
    });
    // PUT /api/commander/config — update commander config
    app.put('/api/commander/config', async (c) => {
        try {
            const body = await c.req.json();
            commanderAgent.updateConfig(body);
            return c.json({ ok: true, config: commanderAgent.getConfig() });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 500);
        }
    });
    // GET /api/commander/config — read current config
    app.get('/api/commander/config', (c) => {
        return c.json(commanderAgent.getConfig());
    });
    // POST /api/commander/tick — trigger a single manual tick
    app.post('/api/commander/tick', async (c) => {
        try {
            await commanderAgent.tick('manual');
            return c.json({ ok: true, state: commanderAgent.getState() });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 500);
        }
    });
    // GET /api/commander/decisions — read persisted decision history
    app.get('/api/commander/decisions', async (c) => {
        const limit = Number(c.req.query('limit')) || 50;
        if (!workflowRoot) {
            return c.json({ decisions: [] });
        }
        const filePath = join(workflowRoot, '.commander', 'decisions.jsonl');
        let raw;
        try {
            raw = await readFile(filePath, 'utf-8');
        }
        catch {
            return c.json({ decisions: [] });
        }
        const lines = raw.split('\n').filter((l) => l.trim());
        const decisions = lines
            .slice(-limit)
            .map((line) => { try {
            return JSON.parse(line);
        }
        catch {
            return null;
        } })
            .filter(Boolean);
        return c.json({ decisions });
    });
    return app;
}
//# sourceMappingURL=commander-routes.js.map