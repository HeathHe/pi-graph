/**
 * Canonical project-root resolution for KG CLI commands.
 *
 * KG uses an explicit project-root override or the containing Git worktree as
 * its implicit boundary, so invoking it from a nested source directory cannot
 * create or query a shadow `.workflow/kg` directory. Outside Git, it follows
 * the shared nearest-workspace resolver used by hooks.
 */
/**
 * Resolve the repository root for a KG CLI command.
 *
 * `MAESTRO_PROJECT_ROOT` is an explicit, hard boundary. Without an override,
 * KG state follows the containing Git worktree so nested source directories
 * cannot create or query a shadow database — unless that Git root has no KG
 * database and a descendant Maestro workspace already does (snapshot git at
 * a parent drive vs the real project folder). Outside Git, use the nearest
 * initialized Maestro workspace, then the external-surface manifest or cwd
 * fallback for an uninitialized project.
 */
export declare function resolveKgCliProjectRoot(startDir?: string): string;
/**
 * Resolve the external-surface manifest carrier before the KG database exists.
 * Validation deliberately reuses the general CLI root so it cannot approve a
 * manifest that sync would ignore.
 */
export declare function resolveExternalSurfaceProjectRoot(startDir?: string): string;
//# sourceMappingURL=project-root.d.ts.map