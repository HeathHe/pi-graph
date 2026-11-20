/**
 * Skill Context Hook — UserPromptSubmit
 *
 * When a user invokes a workflow skill (e.g., `/maestro-ralph` or `/maestro-next`),
 * injects the current canonical Session and sealed Run artifacts.
 *
 * Uses `additionalContext` (not `updatedInput`) to avoid interfering
 * with skill expansion.
 *
 * Formal artifacts are read only from each canonical Session `artifacts.json`.
 */
export interface SkillMatch {
    skill: string;
    phaseNum?: number;
    raw: string;
}
interface HookOutput {
    hookSpecificOutput: {
        hookEventName: string;
        additionalContext: string;
    };
}
export interface SkillContextInput {
    user_prompt?: string;
    cwd?: string;
    session_id?: string;
    hook_event_name?: string;
}
/**
 * Parse a user prompt for workflow skill invocation.
 * Returns null if no skill pattern is matched.
 */
export declare function parseSkillInvocation(prompt: string): SkillMatch | null;
/**
 * Parse any /command-name invocation from user prompt (generalized).
 * Used for skill config parameter injection — works with all commands,
 * not just workflow-specific ones.
 */
export declare function parseAnySkillInvocation(prompt: string): string | null;
/**
 * Evaluate skill context and return workflow state + artifact tree + param defaults.
 * Returns null if no skill invocation detected.
 *
 * Two independent concern layers:
 * 1. Workflow context (state, artifacts, outcomes) — uses canonical Sessions
 * 2. Skill config param injection — works for ANY /command, no workflow required
 */
export declare function evaluateSkillContext(data: SkillContextInput): Promise<HookOutput | null>;
export {};
