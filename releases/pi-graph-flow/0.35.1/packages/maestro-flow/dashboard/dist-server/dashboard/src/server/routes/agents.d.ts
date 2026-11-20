import { Hono } from 'hono';
import type { AgentManager } from '../agents/agent-manager.js';
/**
 * Agent routes following the Hono factory pattern.
 *
 * POST /api/agents/spawn           - spawn a new agent process
 * POST /api/agents/:id/stop        - stop an agent process
 * POST /api/agents/:id/message     - send message to agent
 * POST /api/approvals/:id/respond  - respond to approval request
 * GET  /api/agents                 - list all active processes
 * GET  /api/agents/:id/entries     - get entry history for a process
 */
export declare function createAgentRoutes(agentManager: AgentManager): Hono;
