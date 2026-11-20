import { pgTable, uuid, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.js';
export const organizations = pgTable('organizations', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').unique().notNull(),
    ownerId: uuid('owner_id')
        .references(() => users.id)
        .notNull(),
    plan: text('plan').default('free'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
});
export const organizationMembers = pgTable('organization_members', {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
        .references(() => organizations.id)
        .notNull(),
    userId: uuid('user_id')
        .references(() => users.id)
        .notNull(),
    role: text('role').default('member').notNull(),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
}, (table) => [unique().on(table.orgId, table.userId)]);
export const organizationsRelations = relations(organizations, ({ one, many }) => ({
    owner: one(users, {
        fields: [organizations.ownerId],
        references: [users.id],
    }),
    members: many(organizationMembers),
}));
export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
    organization: one(organizations, {
        fields: [organizationMembers.orgId],
        references: [organizations.id],
    }),
    user: one(users, {
        fields: [organizationMembers.userId],
        references: [users.id],
    }),
}));
//# sourceMappingURL=organizations.js.map