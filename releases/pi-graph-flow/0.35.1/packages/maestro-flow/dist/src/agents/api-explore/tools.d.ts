export interface ToolSchema {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
export declare function executeTool(name: string, argsJson: string, cwd: string): string;
export declare function executeToolAsync(name: string, argsJson: string, cwd: string): Promise<string>;
export declare const TOOL_SCHEMAS: ToolSchema[];
//# sourceMappingURL=tools.d.ts.map