// ---------------------------------------------------------------------------
// Pure selection logic extracted from ComponentGrid for testability.
// ComponentGrid re-exports these for its own use.
// ---------------------------------------------------------------------------
/**
 * Toggle a single ID in the current selection array.
 * If the id is in mandatoryIds, the array is returned unchanged.
 * Returns a new array (immutable).
 */
export function toggleSelection(currentIds, id, mandatoryIds) {
    if (mandatoryIds?.has(id))
        return currentIds;
    return currentIds.includes(id)
        ? currentIds.filter((x) => x !== id)
        : [...currentIds, id];
}
/**
 * Select all available component IDs.
 */
export function selectAllAvailable(availableIds) {
    return [...availableIds];
}
/**
 * Deselect all. If mandatoryIds is provided, those IDs are kept.
 */
export function deselectAll(mandatoryIds) {
    return mandatoryIds ? Array.from(mandatoryIds) : [];
}
/**
 * Restore selection to default: mandatory + defaultSelected components.
 */
export function restoreDefaults(allDefs, mandatoryIds) {
    const ids = new Set();
    if (mandatoryIds)
        for (const id of mandatoryIds)
            ids.add(id);
    for (const def of allDefs) {
        if (def.mandatory || def.defaultSelected !== false)
            ids.add(def.id);
    }
    return Array.from(ids);
}
/**
 * Move the highlight index up with wrapping.
 */
export function moveUp(currentIndex, count) {
    if (count === 0)
        return 0;
    return currentIndex <= 0 ? count - 1 : currentIndex - 1;
}
/**
 * Move the highlight index down with wrapping.
 */
export function moveDown(currentIndex, count) {
    if (count === 0)
        return 0;
    return currentIndex >= count - 1 ? 0 : currentIndex + 1;
}
/**
 * Parse a number key input ('1'-'9') into a 0-based index.
 * Returns -1 if not a valid number key for the given component count.
 */
export function parseNumberKey(input, count) {
    const num = parseInt(input, 10);
    if (isNaN(num) || num < 1 || num > 9 || num > count)
        return -1;
    return num - 1;
}
/**
 * Clamp an index to valid range [0, max(count-1, 0)].
 */
export function clampIndex(index, count) {
    return Math.min(index, Math.max(0, count - 1));
}
//# sourceMappingURL=ComponentGrid.logic.js.map