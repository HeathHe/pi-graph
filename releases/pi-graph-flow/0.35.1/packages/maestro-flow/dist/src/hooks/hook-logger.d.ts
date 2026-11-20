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
export type HookLogLevel = 'error' | 'warn';
export interface HookLogEntry {
    ts: string;
    level: HookLogLevel;
    source: string;
    message: string;
    error?: string;
    stack?: string;
}
/**
 * Record a hook failure. `error` is the caught value (Error object or any
 * throwable). `opts.message` overrides the human-readable summary when the
 * error itself does not carry enough context.
 */
export declare function logHookError(source: string, error: unknown, opts?: {
    message?: string;
}): void;
/** Record an advisory hook warning (non-fatal, e.g. namespace violation). */
export declare function logHookWarn(source: string, message: string): void;
export interface UnreadErrorsResult {
    /** Count of entries newer than the last-seen ts within the window. */
    count: number;
    /** Whether the count was capped by the tail window. */
    capped: boolean;
    /** Max ts (epoch ms) among the unread entries, or null if none. */
    maxTs: number | null;
}
/**
 * Count hook errors/warnings newer than the statusline's last-seen marker,
 * within `windowMs` (default 24h). Used by the statusline alert segment.
 *
 * On any read failure the result is `count: 0` (never throw).
 */
export declare function getRecentUnreadErrors(opts?: {
    windowMs?: number;
    seenTs?: number;
    tailN?: number;
}): UnreadErrorsResult;
/**
 * Render an alert segment like `⚠2` for the statusline, marking the newest
 * error as seen so the next render clears the badge (acts like unread mail:
 * once the badge has shown once, it is considered read).
 *
 * Returns '' when there are no unread entries in the window.
 */
export declare function buildHookErrorAlertSegment(session: string): string;
//# sourceMappingURL=hook-logger.d.ts.map