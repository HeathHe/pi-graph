import { Hono } from 'hono';
import type { StateManager } from '../state/state-manager.js';
/**
 * Board and project routes.
 *
 * GET /api/board    - full BoardState snapshot
 * GET /api/project  - project-level state (state.json)
 */
export declare function createBoardRoutes(stateManager: StateManager): Hono;
