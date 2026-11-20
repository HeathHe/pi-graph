import { pgTable, uuid, text, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
export const permissions = pgTable('permissions', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').unique().notNull(),
    resource: text('resource').notNull(),
    action: text('action').notNull(),
    description: text('description'),
});
export const rolePermissions = pgTable('role_permissions', {
    id: uuid('id').primaryKey().defaultRandom(),
    role: text('role').notNull(),
    permissionId: uuid('permission_id')
        .references(() => permissions.id)
        .notNull(),
}, (table) => [unique().on(table.role, table.permissionId)]);
export const permissionsRelations = relations(permissions, ({ many }) => ({
    rolePermissions: many(rolePermissions),
}));
export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
    permission: one(permissions, {
        fields: [rolePermissions.permissionId],
        references: [permissions.id],
    }),
}));
export const PERMISSION_MATRIX = {
    owner: ['*'],
    admin: [
        'org:read',
        'org:update',
        'member:invite',
        'member:role',
        'member:update',
        'member:remove',
        'project:create',
        'project:read',
        'project:update',
        'project:delete',
        'task:create',
        'task:read',
        'task:update',
        'task:delete',
        'comment:create',
        'comment:read',
        'comment:update',
        'comment:delete',
    ],
    member: [
        'org:read',
        'project:read',
        'project:create',
        'task:create',
        'task:read',
        'task:update',
        'task:delete',
        'comment:create',
        'comment:read',
        'comment:update',
    ],
    guest: ['org:read', 'project:read', 'task:read', 'comment:create', 'comment:read'],
};
//# sourceMappingURL=permissions.js.map