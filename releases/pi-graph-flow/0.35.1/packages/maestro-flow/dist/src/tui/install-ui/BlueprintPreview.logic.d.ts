import { type ComponentDef } from '../../commands/install-backend.js';
/** A group of components sharing the same parent directory. */
export interface TargetGroup {
    parentDir: string;
    entries: Array<{
        subPath: string;
        fileCount: number;
        label: string;
        status?: string;
    }>;
    totalFiles: number;
}
/**
 * Resolve the parent directory from a full target path.
 * Walks segments to find the one containing ".maestro", ".claude", or ".codex"
 * and returns the path up to and including that segment.
 */
export declare function resolveParentDir(targetDir: string): string;
/**
 * Resolve the sub-path (after the parent directory) from a full target path.
 */
export declare function resolveSubPath(targetDir: string): string;
/**
 * Build a grouped tree from resolved component targets.
 * Each group represents a parent directory (e.g. "~/.maestro", "~/.claude").
 */
export declare function buildTree(defs: Array<{
    def: ComponentDef;
    targetDir: string;
    fileCount: number;
    status?: string;
}>): TargetGroup[];
//# sourceMappingURL=BlueprintPreview.logic.d.ts.map