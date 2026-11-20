export declare const DEFAULT_REPOSITORY_MAP_DEPTH = 3;
export declare const MAX_REPOSITORY_MAP_DEPTH = 6;
export declare const DEFAULT_REPOSITORY_MAP_BYTES: number;
export interface RepositoryMap {
    tree: string;
    depth: number;
    sizeBytes: number;
    fellBack: boolean;
    truncated: boolean;
    focusCount?: number;
    /** Existing exact files omitted by ignore rules; these must be read directly. */
    directReadPaths?: string[];
}
export interface RepositoryMapOptions {
    targetDepth?: number;
    maxBytes?: number;
    /** Structured prompt SCOPE paths to prioritize and expand beyond the overview depth. */
    focusPaths?: string[];
}
export declare function normalizeRepositoryMapDepth(value: number | undefined, fallback?: number): number;
export declare function extractRepositoryMapFocusPaths(prompts: string[]): string[];
export declare function extractExplicitFilePaths(prompt: string): string[];
/**
 * Build an ignore-aware repository tree for the first explore prompt.
 * The requested depth is reduced until the map fits the prompt budget.
 */
export declare function buildRepositoryMap(cwd: string, options?: RepositoryMapOptions): RepositoryMap;
//# sourceMappingURL=repository-map.d.ts.map