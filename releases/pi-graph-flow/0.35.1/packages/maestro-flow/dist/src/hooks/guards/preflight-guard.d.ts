export interface PreflightGuardResult {
    /** True if the guard wants to block (only when mode = 'block'). */
    blocked: boolean;
    /** Warning lines (always populated when conflicts exist). */
    warnings: string[];
    /** Number of conflicting teammates. */
    conflictCount: number;
}
export interface PreflightGuardConfig {
    /** 'warn' = emit warnings, 'block' = reject the operation. Default: 'warn' */
    mode: 'warn' | 'block';
    /** Activity look-back window in minutes. Default: 30 */
    windowMin: number;
    /** Whether to run automatically. Default: true */
    enabled: boolean;
}
/**
 * Load preflight guard config from `.workflow/config.json` → `collab` section.
 * Returns defaults on any error.
 */
export declare function loadPreflightConfig(projectRoot: string): PreflightGuardConfig;
/**
 * Evaluate whether the current phase has active teammates.
 *
 * Pure function — takes explicit dependencies for testability.
 * Never throws.
 */
export declare function evaluatePreflightGuard(projectRoot: string, config?: Partial<PreflightGuardConfig>): PreflightGuardResult;
//# sourceMappingURL=preflight-guard.d.ts.map