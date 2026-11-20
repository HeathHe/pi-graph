import { Hono } from 'hono';
/**
 * Scratch routes.
 *
 * GET /api/scratch - all non-phase scratch tasks
 */
export function createScratchRoutes(stateManager) {
    const app = new Hono();
    app.get('/api/scratch', (c) => {
        const board = stateManager.getBoard();
        return c.json(board.scratch);
    });
    return app;
}
//# sourceMappingURL=scratch.js.map