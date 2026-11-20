import type { AgentType } from '../../shared/agent-types.js';
import type { AgentAdapter } from './base-adapter.js';
/**
 * Create an adapter instance for the given agent type.
 * Uses lazy dynamic imports so only the required adapter module is loaded.
 */
export declare function createAdapterForType(agentType: AgentType): Promise<AgentAdapter>;
