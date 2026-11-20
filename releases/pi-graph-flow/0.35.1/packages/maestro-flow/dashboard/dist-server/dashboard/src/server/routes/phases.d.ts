import { Hono } from 'hono';
import type { StateManager } from '../state/state-manager.js';
/**
 * Phase routes.
 *
 * GET /api/phases          - all phases as PhaseCard[]
 * GET /api/phases/:n       - single phase detail
 * GET /api/phases/:n/tasks - tasks for a specific phase
 */
export declare function createPhaseRoutes(stateManager: StateManager): Hono;
