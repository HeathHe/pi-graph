import { pgSchema, uuid, text, timestamp } from 'drizzle-orm/pg-core';
export function createTenantSchema(tenantSlug) {
    const schema = pgSchema(tenantSlug);
    const projects = schema.table('projects', {
        id: uuid('id').primaryKey().defaultRandom(),
        name: text('name').notNull(),
        description: text('description'),
        status: text('status').default('active').notNull(),
        createdBy: uuid('created_by'),
        createdAt: timestamp('created_at').defaultNow().notNull(),
        updatedAt: timestamp('updated_at').defaultNow().notNull(),
    });
    const tasks = schema.table('tasks', {
        id: uuid('id').primaryKey().defaultRandom(),
        projectId: uuid('project_id')
            .references(() => projects.id)
            .notNull(),
        title: text('title').notNull(),
        description: text('description'),
        status: text('status').default('todo').notNull(),
        assigneeId: uuid('assignee_id'),
        createdBy: uuid('created_by'),
        createdAt: timestamp('created_at').defaultNow().notNull(),
        updatedAt: timestamp('updated_at').defaultNow().notNull(),
    });
    return {
        schema,
        projects,
        tasks,
    };
}
//# sourceMappingURL=tenant-schema.js.map