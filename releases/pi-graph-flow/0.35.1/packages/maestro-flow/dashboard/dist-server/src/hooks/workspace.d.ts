/**
 * Workspace Resolver — Finds the project root containing `.workflow/`
 *
 * Walks up from the given directory to find the nearest ancestor
 * containing a `.workflow` directory. Similar to how git finds `.git/`.
 *
 * Used by all workflow-aware hooks to resolve artifact paths correctly
 * regardless of the working directory Claude Code reports.
 */
/**
 * Check if a `.workflow/` directory is a Maestro workspace by verifying
 * either the canonical Session registry or a MaestroGraph database exists.
 * This prevents false positives from other tools that use `.workflow/`, while
 * still allowing KG-only workspaces to use code-search hooks before workflow
 * state init.
 */
export declare function isMaestroWorkspace(dir: string): boolean;
/**
 * Find the nearest ancestor directory containing a valid Maestro `.workflow/`.
 * Returns null if no workspace is found (walks up to filesystem root).
 *
 * Prefers a directory that also contains `.git/` (project root heuristic).
 * Walks up at most 10 levels.
 */
export declare function findWorkspaceRoot(startDir: string): string | null;
/** Loose hook payload shape: fields arrive untyped from host CLIs. */
export interface WorkspaceHint {
    cwd?: unknown;
    workspace_roots?: unknown;
    workspaceRoots?: unknown;
}
/**
 * Directories a host hook may be talking about: cwd, Cursor workspace_roots,
 * and common project-dir env vars. Order is preference, not uniqueness.
 *
 * An explicit `cwd` is not silently replaced by `process.cwd()` — callers that
 * pass a non-workspace directory still get null, matching the old contract.
 */
export declare function workspaceStartDirs(data?: WorkspaceHint, fallbackCwd?: string): string[];
/**
 * Cursor often opens a wrapper folder whose Maestro workspace is one child
 * (e.g. maestrogrok/repo). Walk-up cannot see that; scan immediate children.
 */
export declare function findWorkspaceInImmediateChildren(dir: string): string | null;
/**
 * Resolve the workspace root from hook input data.
 * Tries cwd, workspace_roots, then project-dir env vars, then process.cwd().
 * Returns null if no workspace found.
 */
export declare function resolveWorkspace(data?: WorkspaceHint): string | null;
