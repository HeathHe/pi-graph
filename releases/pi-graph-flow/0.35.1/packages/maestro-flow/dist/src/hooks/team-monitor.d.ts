/**
 * Maestro Team Monitor — PostToolUse Hook (team-lite Wave 2b).
 *
 * Silent heartbeat: every PostToolUse event appends a line to the shared
 * `.workflow/collab/activity.jsonl` so teammates can see who is active
 * on which phase/task.
 *
 * Design constraints (docs/team-lite-design.md section "耦合 1"):
 *   - Team mode off (no member record) -> silent exit 0.
 *   - `user` / `host` come from `members/{uid}.json` via `resolveSelf()`.
 *   - `phase_id` / `task_id` come from `.workflow/state.json` via
 *     `readWorkflowContext()`.
 *   - `action` comes from the hook payload's `tool_name`.
 *   - Dedupe: same `(user, action, phase_id)` within 60s -> skip.
 *     This defends against sub-agent Wave amplification.
 *   - Never throw: this hook must never block the host tool call.
 *   - No hook stdout output (unlike context-monitor / delegate-monitor,
 *     which inject `additionalContext`). The heartbeat is side-effect only.
 */
interface HookInput {
    session_id?: string;
    cwd?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
}
/**
 * Pure hook logic — takes parsed hook input, reports activity if
 * team mode is enabled. Never throws.
 */
export declare function runTeamMonitor(input: HookInput): void;
/** Entry point — reads stdin JSON with 3s timeout, runs monitor, exits 0. */
export declare function runTeamMonitorFromStdin(): void;
export {};
//# sourceMappingURL=team-monitor.d.ts.map