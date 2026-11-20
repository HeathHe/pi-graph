/**
 * Pad a string to a fixed visual width. Truncates if too long.
 * Uses the standard label width by default.
 */
export declare function pad(s: string, width?: number): string;
/**
 * Truncate a string with ellipsis if it exceeds maxLen.
 */
export declare function truncate(s: string, maxLen: number): string;
/**
 * Parse number key input (1-9) and return 0-based index.
 * Returns null if input is not a valid number key for the given item count.
 */
export declare function parseNumberKey(input: string, itemCount: number): number | null;
/**
 * Wrap cursor movement with circular navigation.
 * delta: +1 for down, -1 for up
 */
export declare function wrapCursor(current: number, delta: number, length: number): number;
/**
 * Format file size in human-readable form.
 */
export declare function formatSize(bytes: number): string;
//# sourceMappingURL=helpers.d.ts.map