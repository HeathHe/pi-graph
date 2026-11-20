import type { Context, Next } from 'hono';
export interface UserContext {
    id: string;
    email: string;
}
export declare const authMiddleware: (c: Context, next: Next) => Promise<(Response & import("hono").TypedResponse<{
    error: string;
}, 401, "json">) | undefined>;
export declare function requireAuth(): (c: Context, next: Next) => Promise<(Response & import("hono").TypedResponse<{
    error: string;
}, 401, "json">) | undefined>;
export declare function withAuth(handler: (c: Context) => Response | Promise<Response>): (c: Context) => Promise<Response>;
//# sourceMappingURL=auth.d.ts.map