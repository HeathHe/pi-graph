import type { Context, Next } from 'hono';
export declare function createRateLimiter(options: {
    windowMs: number;
    maxRequests: number;
}): (c: Context, next: Next) => Promise<void | (Response & import("hono").TypedResponse<{
    error: string;
    retryAfter: number;
}, 429, "json">)>;
//# sourceMappingURL=rate-limit.d.ts.map