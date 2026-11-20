import { checkPermission } from '../services/rbac.service.js';
export function requirePermission(resource, action) {
    return async (c, next) => {
        const tenant = c.get('tenant');
        if (!tenant) {
            return c.json({ error: 'Tenant context required' }, 400);
        }
        const allowed = checkPermission(tenant.role, resource, action);
        if (!allowed) {
            return c.json({
                error: 'Forbidden',
                required: `${resource}:${action}`,
                role: tenant.role,
            }, 403);
        }
        await next();
    };
}
//# sourceMappingURL=permission.js.map