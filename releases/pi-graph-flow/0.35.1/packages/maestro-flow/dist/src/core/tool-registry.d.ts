import type { Tool, ToolResult } from '../types/index.js';
export declare class ToolRegistry {
    private tools;
    register(tool: Tool): void;
    unregister(name: string): boolean;
    get(name: string): Tool | undefined;
    list(): Tool[];
    execute(name: string, input: Record<string, unknown>): Promise<ToolResult>;
}
//# sourceMappingURL=tool-registry.d.ts.map