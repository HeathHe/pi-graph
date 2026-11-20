import { Hono } from 'hono';
/**
 * Observability routes following the Hono factory pattern.
 *
 * GET  /api/observability/timeline   cross-component event timeline
 */
export declare function createObservabilityRoutes(workflowRoot: string): Hono;
