import type { Context, Next } from 'hono';
export declare function requirePermission(resource: string, action: string): (c: Context, next: Next) => Promise<(Response & import("hono").TypedResponse<{
    error: string;
}, 400, "json">) | (Response & import("hono").TypedResponse<{
    error: string;
    required: string;
    role: string;
}, 403, "json">) | undefined>;
//# sourceMappingURL=permission.d.ts.map