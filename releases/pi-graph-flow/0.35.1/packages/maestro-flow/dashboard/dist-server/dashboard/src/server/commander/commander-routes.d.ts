import { Hono } from 'hono';
import type { CommanderAgent } from './commander-agent.js';
/**
 * Commander routes following the Hono factory pattern.
 *
 * POST  /api/commander/start   start the commander tick loop
 * POST  /api/commander/stop    stop the commander tick loop
 * POST  /api/commander/pause   pause/resume the commander
 * GET   /api/commander/status  current commander state
 * PUT   /api/commander/config  update commander config
 */
export declare function createCommanderRoutes(commanderAgent: CommanderAgent, workflowRoot?: string): Hono;
