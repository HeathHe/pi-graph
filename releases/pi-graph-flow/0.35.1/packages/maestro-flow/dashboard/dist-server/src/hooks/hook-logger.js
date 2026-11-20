/**
 * Hook error/warning logger — centralized, never-throwing sink for hook
 * failures and advisory warnings.
 *
 * Replaces the ad-hoc `console.error` / `process.stderr.write` calls that
 * previously polluted the Claude Code session output. All entries are
 * written as JSONL to `~/.maestro/logs/hooks-error.log` (the canonical
 * `paths.logs` location), with automatic rotation to `logs/archive/`.
 *
 * Design rules (consistent with `utils/jsonl-log.ts`):
 * - Every function swallows exceptions. Hot-path hooks must never fail the
 *   host tool call, and the statusline (an independent `bin/maestro-statusline.js`
 *   entry point with no `maestro hooks run` dispatcher protection) must never
 *   hang on a stuck log handle. See spec:project:coding-conventions-009.
 * - Writes are synchronous (`appendFileSync` via `appendLine`), so no async
 *   handle lingers after the call returns — preserves the statusline's
 *   deterministic-exit contract.
 * - `MAESTRO_DEBUG=1` additionally echoes the message to stderr so developers
 *   can see failures inline while debugging. Per spec:project:review-standards-002
 *   this is appropriate for read/parse/sync-path degradations, which is what
 *   these hook errors are.
 */
import { join } from 'node:path';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { appendLine, tailLast, rotateIfLarge } from '../utils/jsonl-log.js';
import { paths } from '../config/paths.js';
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const LOG_FILENAME = 'hooks-error.log';
const ARCHIVE_DIRNAME = 'archive';
const ROTATE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const UNREAD_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const STATUS_TAIL_N = 50;
const SEEN_PREFIX = 'maestro-err-seen-';
function logPath() {
    return join(paths.logs, LOG_FILENAME);
}
function archiveDir() {
    return join(paths.logs, ARCHIVE_DIRNAME);
}
function ensureLogDir() {
    try {
        if (!existsSync(paths.logs))
            mkdirSync(paths.logs, { recursive: true });
        const arc = archiveDir();
        if (!existsSync(arc))
            mkdirSync(arc, { recursive: true });
    }
    catch {
        // Swallow — log writes will no-op below on failure.
    }
}
// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------
function nowIso() {
    return new Date().toISOString();
}
function toErrorInfo(err) {
    if (err instanceof Error) {
        return { message: err.message, stack: err.stack };
    }
    if (typeof err === 'string')
        return { message: err };
    if (err == null)
        return {};
    try {
        return { message: JSON.stringify(err) };
    }
    catch {
        return { message: String(err) };
    }
}
function writeEntry(level, source, message, errInfo) {
    try {
        ensureLogDir();
        const entry = {
            ts: nowIso(),
            level,
            source,
            message,
            ...(errInfo?.message ? { error: errInfo.message } : {}),
            ...(errInfo?.stack ? { stack: errInfo.stack } : {}),
        };
        const path = logPath();
        appendLine(path, entry);
        // Best-effort rotation; never throw.
        try {
            rotateIfLarge(path, ROTATE_MAX_BYTES, archiveDir());
        }
        catch {
            /* ignore rotation failure */
        }
    }
    catch {
        // Last resort: nothing more we can do. Do NOT rethrow.
    }
    // Developer echo — read/parse-path degradations only, per review-standards-002.
    if (process.env.MAESTRO_DEBUG === '1') {
        try {
            const errPart = errInfo?.message ? `: ${errInfo.message}` : '';
            const line = `[${source}] ${level.toUpperCase()}: ${message}${errPart}`;
            if (level === 'error')
                console.error(line);
            else
                console.warn(line);
        }
        catch {
            /* ignore */
        }
    }
}
/**
 * Record a hook failure. `error` is the caught value (Error object or any
 * throwable). `opts.message` overrides the human-readable summary when the
 * error itself does not carry enough context.
 */
export function logHookError(source, error, opts) {
    const info = toErrorInfo(error);
    const message = opts?.message ?? info.message ?? 'hook error';
    writeEntry('error', source, message, info);
}
/** Record an advisory hook warning (non-fatal, e.g. namespace violation). */
export function logHookWarn(source, message) {
    writeEntry('warn', source, message);
}
// ---------------------------------------------------------------------------
// Readers — statusline alert segment
// ---------------------------------------------------------------------------
function seenPath(session) {
    return join(tmpdir(), `${SEEN_PREFIX}${session}.json`);
}
function readSeenTs(session) {
    if (!session)
        return 0;
    try {
        const raw = readFileSync(seenPath(session), 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.lastSeenTs === 'number')
            return parsed.lastSeenTs;
    }
    catch {
        /* no or corrupt seen state — treat everything as unread */
    }
    return 0;
}
function writeSeenTs(session, ts) {
    if (!session)
        return;
    try {
        writeFileSync(seenPath(session), JSON.stringify({ lastSeenTs: ts }), 'utf-8');
    }
    catch {
        /* best-effort */
    }
}
/**
 * Count hook errors/warnings newer than the statusline's last-seen marker,
 * within `windowMs` (default 24h). Used by the statusline alert segment.
 *
 * On any read failure the result is `count: 0` (never throw).
 */
export function getRecentUnreadErrors(opts) {
    const windowMs = opts?.windowMs ?? UNREAD_WINDOW_MS;
    const seenTs = opts?.seenTs ?? 0;
    const tailN = opts?.tailN ?? STATUS_TAIL_N;
    try {
        const entries = tailLast(logPath(), tailN);
        if (entries.length === 0)
            return { count: 0, capped: false, maxTs: null };
        const cutoff = Date.now() - windowMs;
        let count = 0;
        let maxTs = 0;
        for (const e of entries) {
            if (!e || typeof e.ts !== 'string')
                continue;
            const t = Date.parse(e.ts);
            if (Number.isNaN(t))
                continue;
            if (t < cutoff)
                continue; // outside window
            if (t <= seenTs)
                continue; // already seen
            count++;
            if (t > maxTs)
                maxTs = t;
        }
        return {
            count,
            capped: entries.length >= tailN && count === entries.length,
            maxTs: count > 0 ? maxTs : null,
        };
    }
    catch {
        return { count: 0, capped: false, maxTs: null };
    }
}
/**
 * Render an alert segment like `⚠2` for the statusline, marking the newest
 * error as seen so the next render clears the badge (acts like unread mail:
 * once the badge has shown once, it is considered read).
 *
 * Returns '' when there are no unread entries in the window.
 */
export function buildHookErrorAlertSegment(session) {
    if (!session)
        return '';
    const seenTs = readSeenTs(session);
    const result = getRecentUnreadErrors({ seenTs });
    if (result.count <= 0)
        return '';
    if (result.maxTs != null)
        writeSeenTs(session, result.maxTs);
    const label = result.count > 9 ? '9+' : String(result.count);
    return `⚠${label}`;
}
//# sourceMappingURL=hook-logger.js.map