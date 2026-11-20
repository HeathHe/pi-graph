import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { users } from '../db/schema/core/users.js';
import { organizationMembers } from '../db/schema/core/organizations.js';
import { requireAuth } from '../middleware/auth.js';
import { createTenantMiddleware } from '../middleware/tenant.js';
import { requirePermission } from '../middleware/permission.js';
import { validateBody, inviteMemberSchema, updateRoleSchema } from '../middleware/validation.js';
export function createMemberRoutes(db, tenantManager) {
    const memberRoutes = new Hono();
    const tenantMiddleware = createTenantMiddleware(db, tenantManager);
    // POST /invite — Invite a member
    memberRoutes.post('/invite', requireAuth(), tenantMiddleware, requirePermission('member', 'invite'), validateBody(inviteMemberSchema), async (c) => {
        const tenant = c.get('tenant');
        const { email, role } = c.get('validatedBody');
        // Find user by email
        const targetUser = await db.query.users.findFirst({
            where: eq(users.email, email),
        });
        if (!targetUser) {
            return c.json({ error: 'User not found' }, 404);
        }
        // Check if already a member
        const existing = await db.query.organizationMembers.findFirst({
            where: and(eq(organizationMembers.orgId, tenant.orgId), eq(organizationMembers.userId, targetUser.id)),
        });
        if (existing) {
            return c.json({ error: 'User is already a member' }, 409);
        }
        // Add member
        await db.insert(organizationMembers).values({
            orgId: tenant.orgId,
            userId: targetUser.id,
            role,
        });
        return c.json({
            member: {
                userId: targetUser.id,
                email: targetUser.email,
                displayName: targetUser.displayName,
                role,
            },
        }, 201);
    });
    // GET / — List members
    memberRoutes.get('/', requireAuth(), tenantMiddleware, async (c) => {
        const tenant = c.get('tenant');
        const members = await db.query.organizationMembers.findMany({
            where: eq(organizationMembers.orgId, tenant.orgId),
            with: {
                user: {
                    columns: {
                        id: true,
                        email: true,
                        displayName: true,
                        avatarUrl: true,
                    },
                },
            },
        });
        return c.json({ members });
    });
    // PATCH /:memberId/role — Update member role
    memberRoutes.patch('/:memberId/role', requireAuth(), tenantMiddleware, requirePermission('member', 'role'), validateBody(updateRoleSchema), async (c) => {
        const tenant = c.get('tenant');
        const { role } = c.get('validatedBody');
        const memberId = c.req.param('memberId') ?? '';
        // Find target membership
        const targetMembership = await db.query.organizationMembers.findFirst({
            where: and(eq(organizationMembers.id, memberId), eq(organizationMembers.orgId, tenant.orgId)),
        });
        if (!targetMembership) {
            return c.json({ error: 'Member not found' }, 404);
        }
        // Cannot modify owner role
        if (targetMembership.role === 'owner') {
            return c.json({ error: 'Cannot modify owner role' }, 403);
        }
        // Update role
        await db
            .update(organizationMembers)
            .set({ role })
            .where(eq(organizationMembers.id, memberId));
        return c.json({
            member: {
                ...targetMembership,
                role,
            },
        });
    });
    // DELETE /:memberId — Remove member
    memberRoutes.delete('/:memberId', requireAuth(), tenantMiddleware, requirePermission('member', 'remove'), async (c) => {
        const tenant = c.get('tenant');
        const memberId = c.req.param('memberId') ?? '';
        // Find target membership
        const targetMembership = await db.query.organizationMembers.findFirst({
            where: and(eq(organizationMembers.id, memberId), eq(organizationMembers.orgId, tenant.orgId)),
        });
        if (!targetMembership) {
            return c.json({ error: 'Member not found' }, 404);
        }
        // Cannot remove owner
        if (targetMembership.role === 'owner') {
            return c.json({ error: 'Cannot remove owner' }, 403);
        }
        // Remove member
        await db
            .delete(organizationMembers)
            .where(eq(organizationMembers.id, memberId));
        return c.json({ message: 'Member removed' });
    });
    return memberRoutes;
}
//# sourceMappingURL=members.js.map