/**
 * Namespace Guard — enforces per-member write isolation (team-lite).
 *
 * Pure function following the evaluate-guards pattern: takes a file path and
 * the current user's uid, returns { allowed, reason? }.
 *
 * Namespace rules:
 *   ALLOWED (own namespace):
 *     .workflow/collab/members/{selfUid}.json
 *     .workflow/collab/specs/{selfUid}/**
 *     .workflow/collab/overlays/{selfUid}-bundle.json
 *   SHARED (writable by any member):
 *     .workflow/collab/activity.jsonl
 *     .workflow/collab/overlays/manifest.json
 *     .workflow/collab/tasks/TASK-*.json
 *     .workflow/collab/tasks/.counter
 *   BLOCKED:
 *     Other members' files in the above namespaces.
 *
 * V1 is advisory — callers log warnings but do not block operations.
 */
export interface NamespaceCheckResult {
    allowed: boolean;
    reason?: string;
}
/**
 * Check if a file path is within the allowed namespace for the given user.
 *
 * @param filePath     Absolute or project-relative path to check.
 * @param selfUid      Current user's uid (e.g. "alice").
 * @param projectRoot  Absolute path to the project root.
 */
export declare function evaluateNamespaceGuard(filePath: string, selfUid: string, projectRoot: string): NamespaceCheckResult;
/**
 * List all allowed write paths for a user within the collab namespace.
 * Returns project-relative paths using forward slashes.
 */
export declare function getNamespaceBoundaries(selfUid: string, projectRoot: string): string[];
