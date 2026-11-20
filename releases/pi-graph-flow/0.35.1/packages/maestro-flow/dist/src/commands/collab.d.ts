import type { Command } from 'commander';
/**
 * Scan `.workflow/collab/overlays/` for bundle files from other team members,
 * import bundles that are newer than previously imported, and update manifest.
 *
 * Returns counts of imported and skipped bundles.
 */
export declare function syncOverlays(projectRoot: string, selfUid: string): {
    imported: number;
    skipped: number;
};
export { runPreflight, type PreflightResult } from '../hooks/preflight-core.js';
export declare function registerCollabCommand(program: Command): void;
//# sourceMappingURL=collab.d.ts.map