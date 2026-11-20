import { z } from 'zod';
import type { Context, Next } from 'hono';
export declare const registerSchema: z.ZodObject<{
    email: z.ZodString;
    password: z.ZodString;
    displayName: z.ZodString;
}, z.core.$strip>;
export declare const loginSchema: z.ZodObject<{
    email: z.ZodString;
    password: z.ZodString;
}, z.core.$strip>;
export declare const refreshTokenSchema: z.ZodObject<{
    refreshToken: z.ZodString;
}, z.core.$strip>;
export declare const createOrgSchema: z.ZodObject<{
    name: z.ZodString;
    slug: z.ZodString;
}, z.core.$strip>;
export declare const updateOrgSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const inviteMemberSchema: z.ZodObject<{
    email: z.ZodString;
    role: z.ZodEnum<{
        admin: "admin";
        member: "member";
        guest: "guest";
    }>;
}, z.core.$strip>;
export declare const updateRoleSchema: z.ZodObject<{
    role: z.ZodEnum<{
        admin: "admin";
        member: "member";
        guest: "guest";
    }>;
}, z.core.$strip>;
export declare function validateBody<T extends z.ZodType>(schema: T): (c: Context, next: Next) => Promise<(Response & import("hono").TypedResponse<{
    error: string;
}, 400, "json">) | undefined>;
//# sourceMappingURL=validation.d.ts.map