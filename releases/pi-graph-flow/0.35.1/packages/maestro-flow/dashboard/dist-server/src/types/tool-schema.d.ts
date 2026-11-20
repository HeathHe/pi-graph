/**
 * CCW-style Tool Schema & Result types
 *
 * Used by ported CCW tools that follow the { schema, handler } export pattern.
 * The adapter function converts CCW ToolResult → maestro ToolResult.
 */
export interface ToolSchema {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}
export interface CcwToolResult<T = unknown> {
    success: boolean;
    result?: T;
    error?: string;
}
export type CcwToolHandler<TParams = Record<string, unknown>, TResult = unknown> = (params: TParams) => Promise<CcwToolResult<TResult>>;
export interface CcwToolRegistration<TParams = Record<string, unknown>> {
    schema: ToolSchema;
    handler: CcwToolHandler<TParams>;
}
export interface McpToolResult {
    content: Array<{
        type: string;
        text: string;
    }>;
    isError?: boolean;
}
/**
 * Convert CCW-style ToolResult to maestro MCP ToolResult
 */
export declare function ccwResultToMcp(ccwResult: CcwToolResult): McpToolResult;
