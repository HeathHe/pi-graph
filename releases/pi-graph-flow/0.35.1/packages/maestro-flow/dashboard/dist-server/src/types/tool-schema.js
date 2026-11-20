/**
 * CCW-style Tool Schema & Result types
 *
 * Used by ported CCW tools that follow the { schema, handler } export pattern.
 * The adapter function converts CCW ToolResult → maestro ToolResult.
 */
/**
 * Convert CCW-style ToolResult to maestro MCP ToolResult
 */
export function ccwResultToMcp(ccwResult) {
    if (ccwResult.success) {
        const text = typeof ccwResult.result === 'string'
            ? ccwResult.result
            : JSON.stringify(ccwResult.result, null, 2);
        return { content: [{ type: 'text', text }] };
    }
    else {
        return {
            content: [{ type: 'text', text: ccwResult.error || 'Unknown error' }],
            isError: true,
        };
    }
}
//# sourceMappingURL=tool-schema.js.map