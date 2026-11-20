import { Hono } from 'hono';
import type { StateManager } from '../state/state-manager.js';
/**
 * Scratch routes.
 *
 * GET /api/scratch - all non-phase scratch tasks
 */
export declare function createScratchRoutes(stateManager: StateManager): Hono;
