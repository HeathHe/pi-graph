export type Role = 'owner' | 'admin' | 'member' | 'guest';
export type Permission = `${string}:${string}`;
export declare function checkPermission(role: Role, resource: string, action: string): boolean;
export declare function checkPermissions(role: Role, required: Permission[]): boolean;
export declare function getRolePermissions(role: Role): Permission[];
export declare function hasAnyPermission(role: Role, resource: string): boolean;
//# sourceMappingURL=rbac.service.d.ts.map