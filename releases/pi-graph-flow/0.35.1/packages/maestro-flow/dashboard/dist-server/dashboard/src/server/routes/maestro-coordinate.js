// ---------------------------------------------------------------------------
// Maestro Coordinate routes — read .workflow/.maestro/ session data
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
export function createMaestroCoordinateRoutes(workflowRoot) {
    const app = new Hono();
    const getRoot = () => typeof workflowRoot === 'function' ? workflowRoot() : workflowRoot;
    // GET /api/maestro-coordinate/sessions — list all maestro sessions
    app.get('/api/maestro-coordinate/sessions', async (c) => {
        try {
            const maestroDir = join(getRoot(), '.maestro');
            const dirNames = await safeReaddir(maestroDir);
            const sessions = [];
            for (const dirName of dirNames) {
                const item = await readSessionListItem(maestroDir, dirName);
                if (item)
                    sessions.push(item);
            }
            // Sort by updatedAt desc (newest first)
            sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
            return c.json(sessions);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 500);
        }
    });
    // GET /api/maestro-coordinate/sessions/:dir — get session detail
    app.get('/api/maestro-coordinate/sessions/:dir', async (c) => {
        try {
            const dirName = c.req.param('dir');
            const maestroDir = join(getRoot(), '.maestro');
            const sessionDir = join(maestroDir, dirName);
            // Try status.json first (ralph + maestro sessions)
            const statusContent = await safeReadFile(join(sessionDir, 'status.json'));
            if (statusContent) {
                try {
                    const raw = JSON.parse(statusContent);
                    const source = detectSource(raw, dirName);
                    if (source === 'ralph') {
                        return c.json({ source: 'ralph', data: raw });
                    }
                    // maestro or unknown — treat as maestro
                    return c.json({ source: 'maestro', data: raw });
                }
                catch {
                    return c.json({ error: 'Failed to parse status.json' }, 500);
                }
            }
            // Try walker-state.json (coordinate sessions)
            const walkerContent = await safeReadFile(join(sessionDir, 'walker-state.json'));
            if (walkerContent) {
                try {
                    const raw = JSON.parse(walkerContent);
                    return c.json({
                        source: 'coordinate',
                        data: raw,
                    });
                }
                catch {
                    return c.json({ error: 'Failed to parse walker-state.json' }, 500);
                }
            }
            return c.json({ error: `Session not found: ${dirName}` }, 404);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 500);
        }
    });
    return app;
}
// ---------------------------------------------------------------------------
// Session list parsing
// ---------------------------------------------------------------------------
async function readSessionListItem(maestroDir, dirName) {
    const sessionDir = join(maestroDir, dirName);
    // Try status.json first
    const statusPath = join(sessionDir, 'status.json');
    const statusContent = await safeReadFile(statusPath);
    if (statusContent) {
        try {
            const raw = JSON.parse(statusContent);
            const source = detectSource(raw, dirName);
            const updatedAt = await getFileMtime(statusPath);
            const steps = Array.isArray(raw.steps) ? raw.steps : [];
            const currentStep = typeof raw.current_step === 'number' ? raw.current_step : 0;
            return {
                dirName,
                source,
                sessionId: raw.session_id ?? dirName,
                intent: raw.intent ?? '',
                status: raw.status ?? 'unknown',
                chainName: raw.chain_name ?? null,
                lifecyclePosition: source === 'ralph' ? raw.lifecycle_position : undefined,
                phase: raw.phase ?? null,
                milestone: raw.milestone,
                currentStep,
                totalSteps: steps.length,
                updatedAt,
            };
        }
        catch {
            return null;
        }
    }
    // Try walker-state.json
    const walkerPath = join(sessionDir, 'walker-state.json');
    const walkerContent = await safeReadFile(walkerPath);
    if (walkerContent) {
        try {
            const raw = JSON.parse(walkerContent);
            const updatedAt = await getFileMtime(walkerPath);
            const history = Array.isArray(raw.history) ? raw.history : [];
            const commandNodes = history.filter((h) => h.node_type === 'command');
            return {
                dirName,
                source: 'coordinate',
                sessionId: raw.session_id ?? dirName,
                intent: raw.intent ?? '',
                status: raw.status ?? 'unknown',
                chainName: raw.graph_id ?? null,
                phase: raw.context?.project?.current_phase ?? null,
                currentStep: commandNodes.length,
                totalSteps: history.length,
                updatedAt,
            };
        }
        catch {
            return null;
        }
    }
    return null;
}
// ---------------------------------------------------------------------------
// Source detection
// ---------------------------------------------------------------------------
function detectSource(raw, dirName) {
    if (raw.source === 'ralph')
        return 'ralph';
    if (raw.source === 'maestro')
        return 'maestro';
    // Fallback: infer from directory prefix
    if (dirName.startsWith('ralph-'))
        return 'ralph';
    if (dirName.startsWith('coord-'))
        return 'coordinate';
    return 'maestro';
}
// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------
async function safeReaddir(dir) {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    }
    catch {
        return [];
    }
}
async function safeReadFile(filePath) {
    try {
        return await readFile(filePath, 'utf-8');
    }
    catch {
        return null;
    }
}
async function getFileMtime(filePath) {
    try {
        const s = await stat(filePath);
        return s.mtime.toISOString();
    }
    catch {
        return new Date().toISOString();
    }
}
//# sourceMappingURL=maestro-coordinate.js.map