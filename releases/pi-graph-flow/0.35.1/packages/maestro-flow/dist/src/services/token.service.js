import { sign, verify } from 'hono/jwt';
import { createHash, randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { refreshTokens } from '../db/schema/core/refresh-tokens.js';
function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET environment variable is required');
    }
    return secret;
}
export async function generateAccessToken(userId, email) {
    const now = Math.floor(Date.now() / 1000);
    return sign({
        sub: userId,
        email,
        iat: now,
        exp: now + 15 * 60, // 15 minutes
    }, getJwtSecret());
}
export async function generateRefreshToken(userId, db) {
    const token = randomUUID();
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await db.insert(refreshTokens).values({
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });
    return token;
}
export async function generateTokenPair(userId, email, db) {
    const accessToken = await generateAccessToken(userId, email);
    const refreshToken = await generateRefreshToken(userId, db);
    return { accessToken, refreshToken };
}
export async function verifyAccessToken(token) {
    try {
        const payload = await verify(token, getJwtSecret(), 'HS256');
        return payload;
    }
    catch {
        return null;
    }
}
export async function rotateRefreshToken(oldToken, db) {
    const tokenHash = createHash('sha256').update(oldToken).digest('hex');
    // Find the stored token
    const stored = await db.query.refreshTokens.findFirst({
        where: eq(refreshTokens.tokenHash, tokenHash),
    });
    if (!stored)
        return null;
    // Check if token is expired
    if (new Date() > stored.expiresAt)
        return null;
    // If already rotated, possible token theft — revoke all user tokens
    if (stored.rotatedAt !== null) {
        await db
            .delete(refreshTokens)
            .where(eq(refreshTokens.userId, stored.userId));
        return null;
    }
    // Mark old token as rotated
    await db
        .update(refreshTokens)
        .set({ rotatedAt: new Date() })
        .where(eq(refreshTokens.id, stored.id));
    // Generate new token pair
    const accessToken = await generateAccessToken(stored.userId, '');
    const newRefreshToken = randomUUID();
    const newTokenHash = createHash('sha256').update(newRefreshToken).digest('hex');
    await db.insert(refreshTokens).values({
        userId: stored.userId,
        tokenHash: newTokenHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        rotatedFrom: stored.id,
    });
    return { accessToken, refreshToken: newRefreshToken };
}
export async function revokeRefreshToken(tokenHash, db) {
    await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
}
export async function revokeAllUserTokens(userId, db) {
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
}
//# sourceMappingURL=token.service.js.map