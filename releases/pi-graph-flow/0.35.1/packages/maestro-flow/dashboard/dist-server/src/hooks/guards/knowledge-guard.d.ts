export interface KnowledgeGuardResult {
    warnings: string[];
}
export interface KnowledgeGuardConfig {
    /** Master switch. Default: true */
    enabled: boolean;
    /** A `maestro search` older than this many minutes counts as absent. Default: 30 */
    windowMin: number;
}
export interface KnowledgeGuardDeps {
    now?: () => number;
}
/**
 * Load guard config from `.workflow/config.json` → `knowledgeGate` section.
 * Returns defaults on any error.
 */
export declare function loadKnowledgeGuardConfig(projectRoot: string): KnowledgeGuardConfig;
/**
 * Evaluate a file-write for knowledge-gate compliance.
 * Pure after construction — takes explicit deps for testability. Never throws.
 */
export declare function evaluateKnowledgeGuard(projectRoot: string, filePath: string, config?: Partial<KnowledgeGuardConfig>, deps?: KnowledgeGuardDeps): KnowledgeGuardResult;
