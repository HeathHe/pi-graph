import { eq } from 'drizzle-orm';
import { users } from '../db/schema/core/users.js';
import { organizations, organizationMembers } from '../db/schema/core/organizations.js';
import { hashPassword } from './password.service.js';
export class ConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConflictError';
    }
}
export async function registerUser(db, input) {
    // Check email uniqueness
    const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);
    if (existing.length > 0) {
        throw new ConflictError('Email already registered');
    }
    // Hash password
    const hashedPassword = await hashPassword(input.password);
    // Create user
    const [newUser] = await db
        .insert(users)
        .values({
        email: input.email,
        passwordHash: hashedPassword,
        displayName: input.displayName,
    })
        .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
    });
    // Create default organization
    const slug = 'org-' + newUser.id.slice(0, 8);
    const [org] = await db
        .insert(organizations)
        .values({
        name: 'My Organization',
        slug,
        ownerId: newUser.id,
    })
        .returning({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
    });
    // Add user as owner
    await db.insert(organizationMembers).values({
        orgId: org.id,
        userId: newUser.id,
        role: 'owner',
    });
    return {
        user: {
            id: newUser.id,
            email: newUser.email,
            displayName: newUser.displayName,
        },
        organization: {
            id: org.id,
            name: org.name,
            slug: org.slug,
            role: 'owner',
        },
    };
}
//# sourceMappingURL=auth.service.js.map