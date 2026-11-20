/**
 * KG Auto-Init Hook — UserPromptSubmit / SessionStart
 *
 * Checks if KG database exists; if not, initializes + runs first sync.
 * Uses kgInitGuard for 5-minute cooldown to avoid repeated init attempts.
 *
 * Failure contract (mirrors kg-sync-hook): a failed attempt MUST remain
 * immediately retryable, so the cooldown is cleared (not marked done) on
 * error. See CooldownGuard.clear() docstring "Failed or racing work must
 * remain immediately retryable."
 */
export interface KgAutoInitResult {
    initialized: boolean;
    reason?: string;
    durationMs?: number;
}
export declare function evaluateKgAutoInit(projectPath: string, sessionId: string): Promise<KgAutoInitResult>;
