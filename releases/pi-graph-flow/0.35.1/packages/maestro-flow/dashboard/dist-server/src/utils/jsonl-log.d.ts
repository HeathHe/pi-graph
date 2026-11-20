/**
 * Append-only JSONL file I/O utility.
 *
 * Shared by agent-domain (team-msg) and human-collab-domain (team-activity)
 * tools that need to read/write newline-delimited JSON logs. All functions
 * are synchronous to match the style of `src/utils/path-validator.ts` and
 * keep them usable from hot-path hooks.
 *
 * Design rules:
 * - Never throw from append/read helpers; callers are often PostToolUse hooks
 *   that must not fail the host tool call.
 * - Malformed lines are silently skipped.
 * - Rotation uses ISO week numbers (no external dependencies).
 */
/**
 * Append a JSON-serializable object as a single line to `path`.
 *
 * - Ensures the parent directory exists (recursive mkdir).
 * - Writes atomically via a single `appendFileSync` call.
 * - Silently no-ops on serialization or I/O errors — callers are hot-path
 *   hooks that should never fail the host tool.
 */
export declare function appendLine(path: string, obj: unknown): void;
/**
 * Read all records from a JSONL file.
 *
 * - Returns `[]` if the file does not exist.
 * - Parses each line with try/catch; malformed lines are skipped.
 */
export declare function readAll<T = unknown>(path: string): T[];
/**
 * Return the last `n` successfully parsed records from a JSONL file.
 *
 * Efficient tail: reads only the last ~64KB of the file unless the file
 * is smaller, in which case it falls back to `readAll`. Partial leading
 * line from the read window is discarded so we never emit a half-parsed
 * record.
 */
export declare function tailLast<T = unknown>(path: string, n: number): T[];
/**
 * Rotate `path` to `archiveDir` if its size is >= `maxBytes`.
 *
 * - Returns `null` if the file does not exist or is below the threshold.
 * - Archive name: `{basename-without-ext}-{YYYY}W{WW}{ext}` (ISO week).
 * - Ensures `archiveDir` exists before moving.
 * - Returns the absolute archive path on success.
 */
export declare function rotateIfLarge(path: string, maxBytes: number, archiveDir: string): string | null;
/**
 * Compute ISO 8601 week number for a date.
 *
 * Reference algorithm (no external dependency):
 *   1. Copy date, adjust to nearest Thursday in the same ISO week
 *      (ISO weeks run Mon-Sun; Thursday anchors the week-year).
 *   2. Week year = year of that Thursday.
 *   3. Week number = 1 + floor((thursday - jan4thOfWeekYear) / 7days),
 *      rounded to the Monday of the week containing Jan 4.
 */
export declare function isoWeek(date: Date): {
    year: number;
    week: number;
};
