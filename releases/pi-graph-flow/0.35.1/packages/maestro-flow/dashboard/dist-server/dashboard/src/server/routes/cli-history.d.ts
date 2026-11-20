import { Hono } from 'hono';
/**
 * CLI history routes.
 *
 * GET /api/cli-history            - list recent executions (?limit=20)
 * GET /api/cli-history/:id/entries - load JSONL entries for an execution
 * GET /api/cli-history/:id/messages - load queued follow-up messages for an async delegate
 */
export declare function createCliHistoryRoutes(): Hono;
