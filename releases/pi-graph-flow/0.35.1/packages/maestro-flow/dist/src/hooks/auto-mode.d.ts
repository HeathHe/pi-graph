/**
 * Auto-mode detection — shared helper for hooks
 *
 * Detects whether the current session is running in `-y` (auto) mode.
 * Two-layer strategy:
 *   1. Bridge file (fast, written by coordinator-tracker on Stop)
 *   2. Direct status.json scan (fallback for first turn before Stop fires)
 */
interface AutoModeInput {
    session_id?: string;
    cwd?: string;
}
/**
 * Returns true if the current maestro session has auto_mode enabled.
 */
export declare function isAutoMode(data: AutoModeInput): boolean;
export {};
//# sourceMappingURL=auto-mode.d.ts.map