export interface TeamWorkPath {
    dir: string;
    scope: 'run' | 'legacy';
    runId?: string;
    sessionId?: string;
}
export interface TeamWorkLocation {
    id: string;
    rootDir: string;
    stateDir: string;
    scope: 'run' | 'legacy';
    runId?: string;
    sessionId?: string;
}
/**
 * Resolve team-private runtime state for a Run.
 *
 * New callers pass the canonical Run ID and land in `{run_dir}/work/team`.
 * Unknown IDs retain the legacy `.workflow/.team/<id>` location so existing
 * team sessions remain readable and resumable during the migration window.
 */
export declare function resolveTeamWorkPath(scopeId: string, projectRoot?: string): TeamWorkPath;
export declare function resolveTeamWorkDir(scopeId: string, projectRoot?: string): string;
/**
 * Enumerate canonical Run-scoped team state with a read-only legacy fallback.
 * Duplicate Run IDs are retained so callers can fail closed instead of
 * implicitly selecting the first directory returned by the filesystem.
 */
export declare function listTeamWorkLocations(workflowRoot?: string): TeamWorkLocation[];
/** Resolve one explicit locator. Ambiguity is an error, never array index 0. */
export declare function findExactTeamWorkLocation(scopeId: string, workflowRoot?: string): TeamWorkLocation | null;
//# sourceMappingURL=team-run-paths.d.ts.map