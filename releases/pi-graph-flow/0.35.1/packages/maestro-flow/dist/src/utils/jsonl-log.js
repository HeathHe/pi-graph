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
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, renameSync, statSync, } from 'node:fs';
import { dirname, basename, extname, join } from 'node:path';
// Bytes read from the tail of the file when efficient tailing.
const TAIL_READ_BYTES = 64 * 1024;
/**
 * Append a JSON-serializable object as a single line to `path`.
 *
 * - Ensures the parent directory exists (recursive mkdir).
 * - Writes atomically via a single `appendFileSync` call.
 * - Silently no-ops on serialization or I/O errors — callers are hot-path
 *   hooks that should never fail the host tool.
 */
export function appendLine(path, obj) {
    try {
        const line = JSON.stringify(obj);
        if (line === undefined)
            return; // unserializable (e.g. bigint, undefined)
        const dir = dirname(path);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        appendFileSync(path, line + '\n', 'utf-8');
    }
    catch {
        // Swallow — hot path.
    }
}
/**
 * Read all records from a JSONL file.
 *
 * - Returns `[]` if the file does not exist.
 * - Parses each line with try/catch; malformed lines are skipped.
 */
export function readAll(path) {
    if (!existsSync(path))
        return [];
    let content;
    try {
        content = readFileSync(path, 'utf-8');
    }
    catch {
        return [];
    }
    return parseLines(content);
}
/**
 * Return the last `n` successfully parsed records from a JSONL file.
 *
 * Efficient tail: reads only the last ~64KB of the file unless the file
 * is smaller, in which case it falls back to `readAll`. Partial leading
 * line from the read window is discarded so we never emit a half-parsed
 * record.
 */
export function tailLast(path, n) {
    if (n <= 0 || !existsSync(path))
        return [];
    let size;
    try {
        size = statSync(path).size;
    }
    catch {
        return [];
    }
    if (size === 0)
        return [];
    // Small file — just read everything.
    if (size <= TAIL_READ_BYTES) {
        const all = readAll(path);
        return all.slice(-n);
    }
    // Large file — read only the tail window.
    const readLen = TAIL_READ_BYTES;
    const start = size - readLen;
    const buf = Buffer.alloc(readLen);
    let fd;
    try {
        fd = openSync(path, 'r');
    }
    catch {
        return [];
    }
    try {
        readSync(fd, buf, 0, readLen, start);
    }
    catch {
        closeSync(fd);
        return [];
    }
    closeSync(fd);
    let content = buf.toString('utf-8');
    // Drop the first (possibly partial) line so we never parse a truncated record.
    const firstNewline = content.indexOf('\n');
    if (firstNewline >= 0) {
        content = content.slice(firstNewline + 1);
    }
    const parsed = parseLines(content);
    return parsed.slice(-n);
}
/**
 * Rotate `path` to `archiveDir` if its size is >= `maxBytes`.
 *
 * - Returns `null` if the file does not exist or is below the threshold.
 * - Archive name: `{basename-without-ext}-{YYYY}W{WW}{ext}` (ISO week).
 * - Ensures `archiveDir` exists before moving.
 * - Returns the absolute archive path on success.
 */
export function rotateIfLarge(path, maxBytes, archiveDir) {
    if (!existsSync(path))
        return null;
    let size;
    try {
        size = statSync(path).size;
    }
    catch {
        return null;
    }
    if (size < maxBytes)
        return null;
    const ext = extname(path);
    const base = basename(path, ext);
    const { year, week } = isoWeek(new Date());
    const archiveName = `${base}-${year}W${String(week).padStart(2, '0')}${ext}`;
    const archivePath = join(archiveDir, archiveName);
    try {
        if (!existsSync(archiveDir)) {
            mkdirSync(archiveDir, { recursive: true });
        }
        renameSync(path, archivePath);
    }
    catch (err) {
        process.stderr.write(`[jsonl-log] rotation failed: ${err.message ?? err}\n`);
        return null;
    }
    return archivePath;
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function parseLines(content) {
    if (!content)
        return [];
    const out = [];
    const lines = content.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            out.push(JSON.parse(trimmed));
        }
        catch {
            // Skip malformed line.
        }
    }
    return out;
}
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
export function isoWeek(date) {
    // Work in UTC to avoid DST / timezone drift.
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    // ISO: Monday=1..Sunday=7. JS getUTCDay: Sunday=0..Saturday=6.
    const dayNum = d.getUTCDay() || 7;
    // Shift to the Thursday of the current ISO week.
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const year = d.getUTCFullYear();
    // Jan 4 is always in ISO week 1.
    const yearStart = new Date(Date.UTC(year, 0, 4));
    const yearStartDayNum = yearStart.getUTCDay() || 7;
    // Monday of ISO week 1.
    const week1Monday = new Date(yearStart);
    week1Monday.setUTCDate(yearStart.getUTCDate() + 1 - yearStartDayNum);
    const diffDays = Math.round((d.getTime() - week1Monday.getTime()) / (24 * 60 * 60 * 1000));
    const week = Math.floor(diffDays / 7) + 1;
    return { year, week };
}
//# sourceMappingURL=jsonl-log.js.map