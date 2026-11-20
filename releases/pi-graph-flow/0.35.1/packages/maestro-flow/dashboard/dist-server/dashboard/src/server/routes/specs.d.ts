import { Hono } from 'hono';
import { parseFrontmatter, type ParsedFrontmatter } from '../wiki/frontmatter-util.js';
import { parseSpecEntries, type SpecEntry } from '../wiki/spec-entry-parser.js';
import { WikiWriter } from '../wiki/writer.js';
export { parseFrontmatter, parseSpecEntries };
export type { ParsedFrontmatter, SpecEntry };
export interface SpecsWikiContext {
    workflowRoot: string;
    writer: WikiWriter;
}
export type SpecsWikiWriterSource = WikiWriter | (() => WikiWriter | SpecsWikiContext);
/**
 * Specs routes following the Hono factory pattern.
 *
 * GET    /api/specs           - list all spec entries across all .md files
 * GET    /api/specs/files     - list spec files with metadata
 * GET    /api/specs/file/:name - read a specific spec file content + entries
 * POST   /api/specs           - add a new entry to a spec file
 * DELETE /api/specs/:id       - remove an entry by ID
 */
export declare function createSpecsRoutes(workflowRoot: string | (() => string), writerSource?: SpecsWikiWriterSource): Hono;
