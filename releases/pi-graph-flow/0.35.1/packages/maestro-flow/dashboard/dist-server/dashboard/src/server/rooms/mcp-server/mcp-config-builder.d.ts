import type { McpSdkServerConfigWithInstance, McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { MeetingRoomSession } from '../meeting-room-session.js';
import type { MeetingRoomMcpServerInfo } from './meeting-room-mcp-server.js';
export interface StdioMcpConfig {
    command: string;
    args: string[];
    env: Record<string, string>;
}
/**
 * Build a stdio server config with env vars pointing to the TCP server.
 * Used by any CLI adapter that spawns the bridge as a child process.
 */
export declare function getStdioConfig(agentId: string, serverInfo: MeetingRoomMcpServerInfo): StdioMcpConfig;
/**
 * Build an McpStdioServerConfig for Claude Code's --mcp-config flag.
 * Returns the config object that can be serialized to JSON and passed
 * as mcpServers entry in Claude Code's config file.
 */
export declare function getClaudeCodeConfig(agentId: string, serverInfo: MeetingRoomMcpServerInfo): McpStdioServerConfig;
/**
 * Build an in-process SDK MCP server that dispatches directly to the session.
 * No TCP overhead -- tools call session methods directly.
 */
export declare function getSdkMcpServer(session: MeetingRoomSession, agentId: string): McpSdkServerConfigWithInstance;
