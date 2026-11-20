// ---------------------------------------------------------------------------
// Room REST API routes — in-memory room session listing + deletion
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
export function createRoomRoutes(roomSessionManager) {
    const app = new Hono();
    // GET /api/rooms — list all room sessions as summaries
    app.get('/api/rooms', (c) => {
        const ids = roomSessionManager.listSessions();
        const summaries = [];
        for (const id of ids) {
            const session = roomSessionManager.getSession(id);
            if (!session)
                continue;
            const snap = session.getSnapshot();
            summaries.push({
                sessionId: snap.sessionId,
                status: snap.status,
                agentCount: snap.agents.length,
                taskCount: snap.tasks.length,
                messageCount: snap.messages.length,
                createdAt: snap.createdAt,
            });
        }
        return c.json(summaries);
    });
    // DELETE /api/rooms/:sessionId — destroy a room session
    app.delete('/api/rooms/:sessionId', async (c) => {
        const sessionId = c.req.param('sessionId');
        const destroyed = await roomSessionManager.destroySession(sessionId);
        if (!destroyed) {
            return c.json({ error: 'Room not found' }, 404);
        }
        return c.json({ ok: true });
    });
    return app;
}
//# sourceMappingURL=rooms.js.map