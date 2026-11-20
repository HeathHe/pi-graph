import { eq, and } from 'drizzle-orm';
import { organizations, organizationMembers } from '../db/schema/core/organizations.js';
export function createTenantMiddleware(db, tenantManager) {
    return async (c, next) => {
        const user = c.get('user');
        if (!user) {
            return c.json({ error: 'Authentication required' }, 401);
        }
        // Parse tenant identifier: Header first
        let tenantSlug = c.req.header('X-Tenant-Id');
        // Fallback: subdomain from Host header
        if (!tenantSlug) {
            const host = c.req.header('Host') || '';
            const parts = host.split('.');
            const subdomain = parts[0];
            if (subdomain && subdomain !== 'www' && subdomain !== 'teamforge' && parts.length > 1) {
                tenantSlug = subdomain;
            }
        }
        if (!tenantSlug) {
            return c.json({ error: 'Tenant not specified. Provide X-Tenant-Id header or use tenant subdomain.' }, 400);
        }
        // Validate slug format
        if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(tenantSlug) && tenantSlug.length > 1) {
            // Allow org- prefix slugs
            if (!/^org-[a-z0-9]+$/.test(tenantSlug)) {
                return c.json({ error: 'Invalid tenant identifier' }, 400);
            }
        }
        // Query organization by slug
        const org = await db.query.organizations.findFirst({
            where: eq(organizations.slug, tenantSlug),
        });
        if (!org) {
            return c.json({ error: 'Organization not found' }, 404);
        }
        // Verify membership
        const membership = await db.query.organizationMembers.findFirst({
            where: and(eq(organizationMembers.orgId, org.id), eq(organizationMembers.userId, user.id)),
        });
        if (!membership) {
            return c.json({ error: 'Access denied: Not a member of this organization' }, 403);
        }
        // Set tenant database connection
        const { db: tenantDb, client } = await tenantManager.getTenantDb(tenantSlug);
        c.set('tenant', { orgId: org.id, slug: tenantSlug, role: membership.role });
        c.set('tenantDb', tenantDb);
        c.set('tenantClient', client);
        try {
            await next();
        }
        finally {
            await tenantManager.releaseTenantConnection(client);
        }
    };
}
//# sourceMappingURL=tenant.js.map