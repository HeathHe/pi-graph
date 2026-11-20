import { Hono } from 'hono';
import type { WorkflowCoordinator } from './workflow-coordinator.js';
/**
 * Coordinator routes following the Hono factory pattern.
 *
 * POST  /api/coordinate/start    start a new coordinate session
 * POST  /api/coordinate/stop     stop the current session
 * GET   /api/coordinate/status   current session state
 * POST  /api/coordinate/resume   resume a stopped/persisted session
 * POST  /api/coordinate/clarify  answer a clarification question
 */
export declare function createCoordinatorRoutes(coordinator: WorkflowCoordinator): Hono;
