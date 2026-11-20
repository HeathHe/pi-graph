import type { Tool, ToolResult } from '../types/index.js';
import type { ToolRegistry } from '../core/tool-registry.js';
import type { AgentRepositoryContext } from '../../shared/agent-types.js';
export interface McpRepositoryAccessOptions {
    /** Host-owned binding captured once when the MCP server starts. */
    repositoryContext?: AgentRepositoryContext;
    /** A binding/configuration error retained so reads can use compatibility mode. */
    repositoryBindingError?: string;
}
export interface McpToolAccessPolicy {
    filter(tools: readonly Tool[]): Tool[];
    execute(registry: ToolRegistry, name: string, input: Record<string, unknown>): Promise<ToolResult>;
}
/**
 * Build one immutable authorization policy for an MCP server instance.
 * Discovery, execution, and repository authority all use the same snapshot.
 */
export declare function createMcpToolAccessPolicy(configuredTools: readonly string[], environmentTools: string | undefined, options?: McpRepositoryAccessOptions): McpToolAccessPolicy;
export interface McpToolRequestHandlers {
    list(): {
        tools: Array<Pick<Tool, 'name' | 'description' | 'inputSchema'>>;
    };
    call(name: string, input: Record<string, unknown>): Promise<ToolResult>;
}
/** Create the paired ListTools and CallTool implementations from one policy. */
export declare function createMcpToolRequestHandlers(registry: ToolRegistry, configuredTools: readonly string[], environmentTools: string | undefined, options?: McpRepositoryAccessOptions): McpToolRequestHandlers;
//# sourceMappingURL=tool-access.d.ts.map