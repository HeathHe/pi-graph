import { Hono } from 'hono';
import type { ExecutionScheduler } from '../execution/execution-scheduler.js';
/**
 * Execution routes following the Hono factory pattern.
 *
 * POST   /api/execution/dispatch       { issueId, executor? }
 * POST   /api/execution/batch          { issueIds, executor?, maxConcurrency? }
 * POST   /api/execution/cancel/:id     cancel running/queued issue
 * GET    /api/execution/status         supervisor status snapshot
 * PUT    /api/execution/supervisor     { enabled, config? }
 */
export declare function createExecutionRoutes(scheduler: ExecutionScheduler): Hono;
