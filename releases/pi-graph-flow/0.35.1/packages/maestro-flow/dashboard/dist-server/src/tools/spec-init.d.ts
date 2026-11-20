/**
 * Spec Init
 *
 * Initialize .workflow/specs/ directory with frontmatter-enabled seed documents.
 * Idempotent: creates missing files, and migrates existing files that lack a
 * YAML frontmatter block by prepending the seed's frontmatter (body preserved).
 */
import { type SpecScope } from './spec-loader.js';
export interface InitResult {
    created: string[];
    migrated: string[];
    skipped: string[];
    directories: string[];
}
/**
 * Initialize the spec system directory structure and seed documents.
 * - Creates the specs directory if missing.
 * - Writes seed files that don't exist.
 * - Migrates existing seed files that lack a YAML frontmatter block by
 *   prepending the canonical frontmatter (body content untouched).
 *
 * @param scope   Target scope: 'project' (default), 'global', 'team', or 'personal'.
 * @param uid     Required when scope is 'personal'.
 * @param preset  Named preset for additional seed docs (e.g. 'academic').
 */
export declare function initSpecSystem(projectPath: string, scope?: SpecScope, uid?: string, preset?: string): InitResult;
/**
 * Ensure a single spec file exists in `specsDir` with the correct YAML
 * frontmatter + body for its filename. No-op if the file already exists
 * with a frontmatter block. If it exists without one, prepends frontmatter.
 *
 * Returns true when the file was created or migrated, false when it was
 * already in good shape or the filename has no registered seed.
 */
export declare function ensureSpecFile(specsDir: string, filename: string): boolean;
