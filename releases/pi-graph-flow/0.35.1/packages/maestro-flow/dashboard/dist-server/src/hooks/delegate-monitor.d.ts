/**
 * Maestro Delegate Monitor — PostToolUse Hook (fallback)
 *
 * Checks /tmp/maestro-notify-{session_id}.jsonl for unread delegate
 * completion notifications. When found, injects additionalContext to inform
 * the model that a delegated task has finished.
 *
 * Primary path: MCP channel notification (notifications/claude/channel).
 * This hook is the fallback when channel is not available.
 */
interface MonitorInput {
    session_id?: string;
    cwd?: string;
    hook_event_name?: string;
}
interface HookOutput {
    hookSpecificOutput: {
        hookEventName: string;
        additionalContext: string;
    };
}
export declare function evaluateDelegateNotifications(data: MonitorInput): HookOutput | null;
export declare function runDelegateMonitor(): void;
export {};
