/**
 * Toggle a single ID in the current selection array.
 * If the id is in mandatoryIds, the array is returned unchanged.
 * Returns a new array (immutable).
 */
export declare function toggleSelection(currentIds: string[], id: string, mandatoryIds?: Set<string>): string[];
/**
 * Select all available component IDs.
 */
export declare function selectAllAvailable(availableIds: string[]): string[];
/**
 * Deselect all. If mandatoryIds is provided, those IDs are kept.
 */
export declare function deselectAll(mandatoryIds?: Set<string>): string[];
/**
 * Restore selection to default: mandatory + defaultSelected components.
 */
export declare function restoreDefaults(allDefs: Array<{
    id: string;
    mandatory?: boolean;
    defaultSelected?: boolean;
}>, mandatoryIds?: Set<string>): string[];
/**
 * Move the highlight index up with wrapping.
 */
export declare function moveUp(currentIndex: number, count: number): number;
/**
 * Move the highlight index down with wrapping.
 */
export declare function moveDown(currentIndex: number, count: number): number;
/**
 * Parse a number key input ('1'-'9') into a 0-based index.
 * Returns -1 if not a valid number key for the given component count.
 */
export declare function parseNumberKey(input: string, count: number): number;
/**
 * Clamp an index to valid range [0, max(count-1, 0)].
 */
export declare function clampIndex(index: number, count: number): number;
//# sourceMappingURL=ComponentGrid.logic.d.ts.map