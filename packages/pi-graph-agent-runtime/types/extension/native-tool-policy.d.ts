/** Never pass new exposure metadata to legacy hosts. */
export declare function modelOnlyControlTool<T extends {
    name: string;
}>(tool: T, version: unknown): T;
