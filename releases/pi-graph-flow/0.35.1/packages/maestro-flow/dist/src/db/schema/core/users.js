import { pgTable, uuid, text, boolean, timestamp } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').unique().notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    emailVerified: boolean('email_verified').default(false),
    oauthProvider: text('oauth_provider'),
    oauthId: text('oauth_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
//# sourceMappingURL=users.js.map