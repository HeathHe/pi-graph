import { verifyAccessToken } from '../services/token.service.js';
export const authMiddleware = async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized: Missing token' }, 401);
    }
    const token = authHeader.slice(7);
    const payload = await verifyAccessToken(token);
    if (!payload) {
        return c.json({ error: 'Unauthorized: Invalid token' }, 401);
    }
    c.set('user', { id: payload.sub, email: payload.email });
    await next();
};
export function requireAuth() {
    return authMiddleware;
}
export function withAuth(handler) {
    return async (c) => {
        const user = c.get('user');
        if (!user) {
            return c.json({ error: 'Unauthorized' }, 401);
        }
        return handler(c);
    };
}
//# sourceMappingURL=auth.js.map