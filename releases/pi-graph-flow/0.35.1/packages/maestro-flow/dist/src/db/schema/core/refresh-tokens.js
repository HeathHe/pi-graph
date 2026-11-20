import { pgTable, uuid, text, timestamp, boolean } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.js';
export const refreshTokens = pgTable('refresh_tokens', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
        .references(() => users.id)
        .notNull(),
    tokenHash: text('token_hash').unique().notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    rotatedAt: timestamp('rotated_at'),
    rotatedFrom: uuid('rotated_from'),
    revoked: boolean('revoked').default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});
export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
    user: one(users, {
        fields: [refreshTokens.userId],
        references: [users.id],
    }),
}));
//# sourceMappingURL=refresh-tokens.js.map