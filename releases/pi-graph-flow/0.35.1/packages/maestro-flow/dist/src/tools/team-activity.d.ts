/**
 * Human-team activity log (team-lite collaboration, Wave 2).
 *
 * Owns `.workflow/collab/activity.jsonl` — append-only activity bus shared
 * across a small human team. Each entry records "who did what, when, where".
 *
 * Strict namespace separation: this module belongs to the HUMAN collaboration
 * domain (`.workflow/collab/`) and must NEVER touch `.workflow/.team/` which
 * is the agent pipeline message bus owned by `src/tools/team-msg.ts`.
 *
 * Hot-path contract: `reportActivity` is called from PostToolUse hooks and
 * must NEVER throw. The underlying `appendLine` from `src/utils/jsonl-log.ts`
 * already swallows errors; we rely on that and add best-effort wrappers.
 */
export interface ActivityEvent {
    ts: string;
    user: string;
    host: string;
    action: string;
    phase_id?: number;
    task_id?: string;
    target?: string;
}
/** Absolute path to the current activity log. */
export declare function getActivityLogPath(): string;
/** Absolute path to the activity archive directory. */
export declare function getArchiveDir(): string;
/**
 * Append an activity event to the shared log.
 *
 * - `ts` is auto-filled to `new Date().toISOString()` if omitted.
 * - Silently no-ops on any error — this is called from hot paths.
 */
export declare function reportActivity(evt: Omit<ActivityEvent, 'ts'> & {
    ts?: string;
}): void;
/**
 * Return activity events from the last `windowMinutes` minutes.
 *
 * Algorithm (matches docs/team-lite-design.md section "耦合 3"):
 *   1. Tail the last 500 lines of activity.jsonl.
 *   2. Drop malformed entries (`tailLast` already does this).
 *   3. Keep events with `ts >= now - (windowMinutes + CLOCK_TOLERANCE_MIN)`
 *      to absorb cross-machine clock drift.
 *
 * Results are returned in the natural tail order (oldest -> newest), which
 * is what `team status` wants for grouping by user.
 */
export declare function readRecentActivity(windowMinutes: number): ActivityEvent[];
/**
 * Read the current workflow context from `.workflow/state.json`.
 *
 * Returns:
 *   - `phase_id` from `current_phase` (if present & numeric)
 *   - `task_id`  from `current_task_id` (if present & string)
 *
 * Both fields are optional. Missing state file, parse errors, or missing
 * fields return `{}` — callers tag activity events with whatever is known.
 *
 * Note: `current_task_id` depends on P0.1 which may not be landed yet.
 */
export declare function readWorkflowContext(): {
    phase_id?: number;
    task_id?: string;
};
/**
 * Rotate the activity log if it exceeds `maxBytes`.
 *
 * Delegates to `rotateIfLarge` in `src/utils/jsonl-log.ts`, which moves the
 * file to `.workflow/collab/activity-archives/activity-{YYYY}W{WW}.jsonl`.
 *
 * Returns the archive path on success, or `null` if rotation did not run
 * (file missing, below threshold, or I/O error).
 */
export declare function rotateIfNeeded(maxBytes?: number): string | null;
//# sourceMappingURL=team-activity.d.ts.map