import { Hono } from 'hono';
import type { RequirementExpander } from '../requirement/requirement-expander.js';
/**
 * Requirement routes following the Hono factory pattern.
 *
 * GET    /api/requirements              - list all expanded requirements
 * POST   /api/requirements/expand       - expand user text into structured requirement
 * POST   /api/requirements/:id/refine   - refine an existing expansion with feedback
 * POST   /api/requirements/:id/commit   - commit requirement as issues or coordinate session
 * GET    /api/requirements/:id          - get a single expanded requirement by ID
 */
export declare function createRequirementRoutes(requirementExpander: RequirementExpander): Hono;
