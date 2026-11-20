import { PERMISSION_MATRIX } from '../db/schema/core/permissions.js';
export function checkPermission(role, resource, action) {
    const permissions = PERMISSION_MATRIX[role];
    if (!permissions)
        return false;
    // Global wildcard
    if (permissions.includes('*'))
        return true;
    // Exact match
    if (permissions.includes(`${resource}:${action}`))
        return true;
    // Resource wildcard
    if (permissions.includes(`${resource}:*`))
        return true;
    return false;
}
export function checkPermissions(role, required) {
    return required.every((p) => {
        const parts = p.split(':');
        const resource = parts[0];
        const action = parts.slice(1).join(':');
        return checkPermission(role, resource, action);
    });
}
export function getRolePermissions(role) {
    return (PERMISSION_MATRIX[role] || []);
}
export function hasAnyPermission(role, resource) {
    const permissions = PERMISSION_MATRIX[role];
    if (!permissions)
        return false;
    if (permissions.includes('*'))
        return true;
    return permissions.some((p) => p.startsWith(`${resource}:`));
}
//# sourceMappingURL=rbac.service.js.map