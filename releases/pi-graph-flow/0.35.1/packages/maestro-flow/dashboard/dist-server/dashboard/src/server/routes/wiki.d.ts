import { Hono } from 'hono';
import type { DashboardEventBus } from '../state/event-bus.js';
import { WikiIndexer } from '../wiki/wiki-indexer.js';
import { WikiWriter } from '../wiki/writer.js';
export interface WikiRouteContext {
    workflowRoot: string;
    indexer: WikiIndexer;
    writer: WikiWriter;
}
export type DisposableWikiRoutes = Hono & {
    dispose: () => void;
};
/**
 * /api/wiki — unified wiki endpoint backed by WikiIndexer.
 *
 * Reads files under `.workflow/` (specs, project.md, roadmap.md,
 * memory/) plus virtual entries adapted from JSONL sources (issues,
 * learning). JSONL rows are read-only reflections; never mutated by this
 * route.
 *
 * Capabilities (turbovault-inspired):
 *   - Graph analysis (backlinks, forward links, orphans, hubs, broken links)
 *   - BM25 full-text search (replaces naive substring filter when `q` is set)
 *   - Health audit (/api/wiki/health)
 *   - Scoped markdown write ops (POST/PUT/DELETE for real `.md` entries)
 *
 * A request resolves exactly one context. Workspace switches atomically
 * replace that context, so later requests cannot retain the previous writer.
 */
export declare function createWikiRoutes(workflowRoot: () => string, eventBus: DashboardEventBus): DisposableWikiRoutes;
/**
 * Factory that creates wiki routes and exposes the same request-resolved
 * context to other route modules (for example specs). Only one indexer/writer
 * pair exists for the current workspace.
 */
export declare function createSharedWikiWriter(workflowRoot: () => string, eventBus: DashboardEventBus): {
    routes: DisposableWikiRoutes;
    getWriter: () => WikiWriter;
    getContext: () => WikiRouteContext;
    dispose: () => void;
};
