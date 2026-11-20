import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { DelegateChannelRelay } from './delegate-channel-relay.js';
import { type McpRepositoryAccessOptions } from './tool-access.js';
export declare function getMcpServer(): Server | null;
export declare function getDelegateRelay(): DelegateChannelRelay | null;
/** Bind the MCP process to the installed manifest identity without cwd fallback. */
export declare function resolveMcpRepositoryAccess(env?: NodeJS.ProcessEnv): McpRepositoryAccessOptions;
export declare function startMcpServer(): Promise<void>;
//# sourceMappingURL=server.d.ts.map