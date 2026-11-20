import { type OverlayFile } from './types.js';
export declare class OverlayLoadError extends Error {
    readonly filePath: string;
    readonly errors: string[];
    constructor(filePath: string, errors: string[]);
}
export declare function loadOverlay(filePath: string): OverlayFile;
/** Returns a list of validation error strings. Empty = valid. */
export declare function validateOverlayMeta(input: unknown): string[];
export interface LoadAllResult {
    overlays: OverlayFile[];
    errors: {
        path: string;
        errors: string[];
    }[];
}
/**
 * Load all valid top-level overlay JSON files from `dir`.
 * Ignores subdirectories (docs/, _shipped/ etc), files starting with `_`,
 * and non-.json files. Returns both successful overlays and collected errors
 * so callers can report them without throwing.
 *
 * Sorted by (priority ?? 50) asc, then name asc.
 */
export declare function loadAllOverlays(dir: string): LoadAllResult;
//# sourceMappingURL=loader.d.ts.map