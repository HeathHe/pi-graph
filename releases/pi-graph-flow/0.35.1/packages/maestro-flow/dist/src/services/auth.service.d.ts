export declare class ConflictError extends Error {
    constructor(message: string);
}
interface RegisterInput {
    email: string;
    password: string;
    displayName: string;
}
interface RegisterResult {
    user: {
        id: string;
        email: string;
        displayName: string;
    };
    organization: {
        id: string;
        name: string;
        slug: string;
        role: 'owner';
    };
}
export declare function registerUser(db: any, input: RegisterInput): Promise<RegisterResult>;
export {};
//# sourceMappingURL=auth.service.d.ts.map