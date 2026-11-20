/**
 * Spec Injector — PreToolUse:Agent Hook
 *
 * Automatically injects project specs into subagent context based on
 * agent type → spec category mapping. Uses context-budget to reduce
 * payload when context usage is high.
 *
 * Design: Uses `additionalContext` (advisory) rather than rewriting
 * the prompt — safer and non-destructive.
 */
import type { SpecInjectionConfig } from '../types/index.js';
export interface SpecInjectionResult {
    inject: boolean;
    content?: string;
    categories?: string[];
    specCount?: number;
    budgetAction?: string;
}
/**
 * Evaluate whether to inject specs for a given agent type.
 *
 * @param agentType   The subagent_type from PreToolUse tool_input
 * @param projectPath Working directory (for spec file resolution)
 * @param sessionId   Session ID (for context budget bridge metrics)
 * @param config      Optional user config overrides
 * @param uid         Optional team member uid for personal spec layer
 */
export declare function evaluateSpecInjection(agentType: string, projectPath: string, sessionId?: string, config?: SpecInjectionConfig, uid?: string): SpecInjectionResult;
/**
 * Record consumption of the injected spec categories in the credibility table.
 *
 * Split out of `evaluateSpecInjection` and awaited by the caller instead of
 * running as a fire-and-forget IIFE inside it: the `maestro hooks run` dispatcher
 * ends with `process.exit(0)`, so an unawaited promise here was not
 * "best-effort" — it was reliably killed mid-write, paying the sqlite open for a
 * row update that never landed. Measured cost of doing it properly: ~24ms
 * (engine import ~18 + open ~3 + one SELECT + 21 UPDATEs inside a transaction).
 *
 * Still best-effort in the sense that any failure is swallowed — analytics must
 * never break injection.
 */
export declare function recordSpecInjectionCredibility(projectPath: string, categories: string[]): Promise<void>;
