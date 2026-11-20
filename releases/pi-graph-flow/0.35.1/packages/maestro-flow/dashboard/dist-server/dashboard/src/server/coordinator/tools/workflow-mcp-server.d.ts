import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { StateManager } from '../../state/state-manager.js';
export declare function createWorkflowMcpServer(stateManager: StateManager, workflowRoot: string): McpSdkServerConfigWithInstance;
