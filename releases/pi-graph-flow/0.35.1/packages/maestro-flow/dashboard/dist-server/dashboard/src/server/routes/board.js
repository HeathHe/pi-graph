import { Hono } from 'hono';
/**
 * Board and project routes.
 *
 * GET /api/board    - full BoardState snapshot
 * GET /api/project  - project-level state (state.json)
 */
export function createBoardRoutes(stateManager) {
    const app = new Hono();
    app.get('/api/board', (c) => {
        return c.json(stateManager.getBoard());
    });
    app.get('/api/project', (c) => {
        return c.json(stateManager.getProject());
    });
    return app;
}
//# sourceMappingURL=board.js.map