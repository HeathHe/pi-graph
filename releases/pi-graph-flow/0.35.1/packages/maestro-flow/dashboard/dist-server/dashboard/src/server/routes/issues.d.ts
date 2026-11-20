import { Hono } from 'hono';
/**
 * Issue routes following the Hono factory pattern.
 *
 * GET    /api/issues              - list all issues (optional ?status=&type= filters)
 * POST   /api/issues              - create a new issue
 * GET    /api/issues/:id          - get a single issue by ID
 * PATCH  /api/issues/:id          - update an existing issue
 * PATCH  /api/issues/:id/analysis - set issue analysis
 * PATCH  /api/issues/:id/solution - set issue solution plan
 * DELETE /api/issues/:id          - delete an issue
 */
export declare function createIssueRoutes(workflowRoot: string | (() => string)): Hono;
