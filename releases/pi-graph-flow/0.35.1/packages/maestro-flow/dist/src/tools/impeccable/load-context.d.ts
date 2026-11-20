export interface ContextResult {
    hasProduct: boolean;
    product: string | null;
    productPath: string | null;
    hasDesign: boolean;
    design: string | null;
    designPath: string | null;
    migrated: boolean;
    contextDir: string;
}
export declare function resolveContextDir(cwd?: string): string;
export declare function loadContext(cwd?: string): ContextResult;
//# sourceMappingURL=load-context.d.ts.map