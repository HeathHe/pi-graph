/**
 * Session Context Hook — Notification (SessionStart)
 *
 * Injects lightweight workflow state + available specs overview
 * at session initialization. Does NOT inject full spec content —
 * that's handled per-agent by spec-injector.
 */
interface SessionContextInput {
    cwd?: string;
    session_id?: string;
    hook_event_name?: string;
}
interface HookOutput {
    hookSpecificOutput: {
        hookEventName: string;
        additionalContext: string;
    };
}
/**
 * Evaluate session context and return an overview for the agent.
 * Returns null if there's nothing useful to inject.
 */
export declare function evaluateSessionContext(data: SessionContextInput): HookOutput | null;
export {};
