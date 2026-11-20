import type { AppliedTarget, OverlayFile } from './types.js';
export declare function shortHash(input: string): string;
export interface ApplyResult {
    text: string;
    applied: AppliedTarget;
    /** True if the output is byte-identical to the input. */
    unchanged: boolean;
}
/**
 * Apply all of an overlay's patches to the target file content.
 *
 * The file is reparsed after each marker edit so subsequent patches see
 * the updated line indices.
 */
export declare function applyOverlay(text: string, overlay: OverlayFile, commandName: string, commandPath: string): ApplyResult;
/**
 * Remove every marker block for a given overlay name from the text.
 * Returns the cleaned text and the patch indices that were removed.
 */
export declare function removeOverlay(text: string, overlayName: string): {
    text: string;
    removed: number[];
};
/** Detect whether `text` already contains markers for this overlay name. */
export declare function hasMarkers(text: string, overlayName: string): boolean;
//# sourceMappingURL=patcher.d.ts.map