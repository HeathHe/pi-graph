import { Hono } from 'hono';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema/core/users.js';
import { registerUser, ConflictError } from '../services/auth.service.js';
import { generateTokenPair, verifyAccessToken, rotateRefreshToken, revokeRefreshToken, revokeAllUserTokens, } from '../services/token.service.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { validateBody, registerSchema, loginSchema, refreshTokenSchema } from '../middleware/validation.js';
import { verifyPassword } from '../services/password.service.js';
export function createAuthRoutes(db) {
    const authRoutes = new Hono();
    // POST /register
    authRoutes.post('/register', createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 5 }), validateBody(registerSchema), async (c) => {
        const body = c.get('validatedBody');
        const result = await registerUser(db, body);
        const tokens = await generateTokenPair(result.user.id, result.user.email, db);
        return c.json({ ...result, tokens }, 201);
    });
    // POST /login
    authRoutes.post('/login', createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 10 }), validateBody(loginSchema), async (c) => {
        const { email, password } = c.get('validatedBody');
        const user = await db.query.users.findFirst({
            where: eq(users.email, email),
        });
        if (!user) {
            return c.json({ error: 'Invalid credentials' }, 401);
        }
        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) {
            return c.json({ error: 'Invalid credentials' }, 401);
        }
        const tokens = await generateTokenPair(user.id, user.email, db);
        return c.json({
            user: {
                id: user.id,
                email: user.email,
                displayName: user.displayName,
            },
            tokens,
        });
    });
    // POST /refresh
    authRoutes.post('/refresh', validateBody(refreshTokenSchema), async (c) => {
        const { refreshToken } = c.get('validatedBody');
        const tokens = await rotateRefreshToken(refreshToken, db);
        if (!tokens) {
            return c.json({ error: 'Invalid or expired refresh token' }, 401);
        }
        return c.json({ tokens });
    });
    // POST /logout
    authRoutes.post('/logout', async (c) => {
        const authHeader = c.req.header('Authorization');
        const token = authHeader?.replace('Bearer ', '');
        if (token) {
            const payload = await verifyAccessToken(token);
            if (payload) {
                await revokeAllUserTokens(payload.sub, db);
            }
        }
        const body = await c.req.json().catch(() => ({}));
        if (body.refreshToken) {
            const hash = createHash('sha256').update(body.refreshToken).digest('hex');
            await revokeRefreshToken(hash, db);
        }
        return c.json({ message: 'Logged out' });
    });
    // Error handler
    authRoutes.onError((err, c) => {
        if (err instanceof ConflictError) {
            return c.json({ error: err.message }, 409);
        }
        return c.json({ error: 'Internal server error' }, 500);
    });
    return authRoutes;
}
//# sourceMappingURL=auth.js.map