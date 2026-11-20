/**
 * Delegate MCP tool — spawn / follow-up / inspect / cancel CLI delegates.
 *
 * Default mode is analysis (read-only). write must be set explicitly.
 * Spawn is always async so the MCP request does not block.
 */
import type { ToolSchema, CcwToolResult } from '../types/tool-schema.js';
import { CliHistoryStore } from '../agents/cli-history-store.js';
import { DelegateBrokerClient } from '../async/delegate-broker-client.js';
import { type DelegateExecutionRequest } from '../commands/delegate.js';
import { type CliToolsConfig } from '../config/cli-tools-config.js';
export interface DelegateMcpDeps {
    loadConfig?: (workDir?: string) => Promise<CliToolsConfig>;
    launch?: (request: DelegateExecutionRequest) => void;
    historyStore?: CliHistoryStore;
    broker?: DelegateBrokerClient;
}
export declare const schema: ToolSchema;
export declare function handler(params: Record<string, unknown>, deps?: DelegateMcpDeps): Promise<CcwToolResult>;
//# sourceMappingURL=delegate-mcp.d.ts.map