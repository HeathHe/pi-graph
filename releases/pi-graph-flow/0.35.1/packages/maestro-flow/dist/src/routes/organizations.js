import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { organizations, organizationMembers } from '../db/schema/core/organizations.js';
import { requireAuth } from '../middleware/auth.js';
import { createTenantMiddleware } from '../middleware/tenant.js';
import { requirePermission } from '../middleware/permission.js';
import { validateBody, createOrgSchema, updateOrgSchema } from '../middleware/validation.js';
export function createOrgRoutes(db, tenantManager, migrator) {
    const orgRoutes = new Hono();
    const tenantMiddleware = createTenantMiddleware(db, tenantManager);
    // POST / — Create organization
    orgRoutes.post('/', requireAuth(), validateBody(createOrgSchema), async (c) => {
        const user = c.get('user');
        const { name, slug } = c.get('validatedBody');
        // Check slug uniqueness
        const existing = await db.query.organizations.findFirst({
            where: eq(organizations.slug, slug),
        });
        if (existing) {
            return c.json({ error: 'Organization slug already exists' }, 409);
        }
        // Create organization
        const [org] = await db
            .insert(organizations)
            .values({ name, slug, ownerId: user.id })
            .returning({
            id: organizations.id,
            name: organizations.name,
            slug: organizations.slug,
        });
        // Add creator as owner
        await db.insert(organizationMembers).values({
            orgId: org.id,
            userId: user.id,
            role: 'owner',
        });
        // Trigger tenant schema creation
        try {
            await tenantManager.createNewTenant(slug, migrator);
        }
        catch {
            // Schema creation may fail if DB not connected; log but don't block
        }
        return c.json({
            organization: {
                id: org.id,
                name: org.name,
                slug: org.slug,
                role: 'owner',
            },
        }, 201);
    });
    // GET / — List user's organizations
    orgRoutes.get('/', requireAuth(), async (c) => {
        const user = c.get('user');
        const memberships = await db.query.organizationMembers.findMany({
            where: eq(organizationMembers.userId, user.id),
            with: { organization: true },
        });
        return c.json({
            organizations: memberships.map((m) => ({
                ...m.organization,
                role: m.role,
            })),
        });
    });
    // GET /:slug — Get organization details
    orgRoutes.get('/:slug', requireAuth(), tenantMiddleware, async (c) => {
        const tenant = c.get('tenant');
        return c.json({ organization: tenant });
    });
    // PATCH /:slug — Update organization
    orgRoutes.patch('/:slug', requireAuth(), tenantMiddleware, requirePermission('org', 'update'), validateBody(updateOrgSchema), async (c) => {
        const tenant = c.get('tenant');
        const { name } = c.get('validatedBody');
        if (name) {
            await db
                .update(organizations)
                .set({ name, updatedAt: new Date() })
                .where(eq(organizations.id, tenant.orgId));
        }
        return c.json({
            organization: { ...tenant, name: name || tenant.slug },
        });
    });
    // DELETE /:slug — Soft delete organization
    orgRoutes.delete('/:slug', requireAuth(), tenantMiddleware, requirePermission('org', 'delete'), async (c) => {
        const tenant = c.get('tenant');
        await db
            .update(organizations)
            .set({ deletedAt: new Date() })
            .where(eq(organizations.id, tenant.orgId));
        return c.json({ message: 'Organization deleted' });
    });
    return orgRoutes;
}
//# sourceMappingURL=organizations.js.map