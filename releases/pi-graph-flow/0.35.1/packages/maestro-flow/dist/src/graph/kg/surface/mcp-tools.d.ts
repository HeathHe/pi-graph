export interface McpToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
export declare const KG_MCP_TOOLS: McpToolDef[];
export type KgStatus = 'ready' | 'stale' | 'uninitialized';
export interface KgPrecheck {
    status: KgStatus;
    message: string;
}
export declare function precheckKg(projectPath: string): KgPrecheck;
export declare function handleMcpTool(toolName: string, input: Record<string, unknown>, projectPath: string): Promise<{
    content: Array<{
        type: string;
        text: string;
    }>;
    isError: boolean;
}>;
//# sourceMappingURL=mcp-tools.d.ts.map