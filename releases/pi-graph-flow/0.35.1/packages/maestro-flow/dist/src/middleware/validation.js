import { z } from 'zod';
export const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8).max(128),
    displayName: z.string().min(1).max(100),
});
export const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});
export const refreshTokenSchema = z.object({
    refreshToken: z.string().min(1),
});
export const createOrgSchema = z.object({
    name: z.string().min(1).max(200),
    slug: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
});
export const updateOrgSchema = z.object({
    name: z.string().min(1).max(200).optional(),
});
export const inviteMemberSchema = z.object({
    email: z.string().email(),
    role: z.enum(['admin', 'member', 'guest']),
});
export const updateRoleSchema = z.object({
    role: z.enum(['admin', 'member', 'guest']),
});
export function validateBody(schema) {
    return async (c, next) => {
        try {
            const body = await c.req.json();
            const result = schema.parse(body);
            c.set('validatedBody', result);
            await next();
        }
        catch (error) {
            if (error instanceof z.ZodError) {
                return c.json({
                    error: 'Validation failed',
                    details: error.issues,
                }, 400);
            }
            return c.json({ error: 'Invalid request body' }, 400);
        }
    };
}
//# sourceMappingURL=validation.js.map