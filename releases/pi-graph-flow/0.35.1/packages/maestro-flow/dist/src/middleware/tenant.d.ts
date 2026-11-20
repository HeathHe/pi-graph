import type { Context, Next } from 'hono';
import { TenantConnectionManager } from '../db/connection-pool.js';
export interface TenantContext {
    orgId: string;
    slug: string;
    role: string;
}
export declare function createTenantMiddleware(db: any, tenantManager: TenantConnectionManager): (c: Context, next: Next) => Promise<(Response & import("hono").TypedResponse<{
    error: string;
}, 401, "json">) | (Response & import("hono").TypedResponse<{
    error: string;
}, 400, "json">) | (Response & import("hono").TypedResponse<{
    error: string;
}, 404, "json">) | (Response & import("hono").TypedResponse<{
    error: string;
}, 403, "json">) | undefined>;
//# sourceMappingURL=tenant.d.ts.map