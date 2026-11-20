// ---------------------------------------------------------------------------
// Execution system types — orchestrator state, supervisor config, slots
// ---------------------------------------------------------------------------
export const DEFAULT_SCHEDULER_CONFIG = {
    enabled: false,
    strategy: 'priority',
    pollIntervalMs: 30_000,
    maxConcurrentAgents: 3,
    stallTimeoutMs: 300_000,
    maxRetries: 2,
    retryBackoffMs: 60_000,
    defaultPromptMode: 'direct',
    defaultExecutor: 'claude-code',
    workspace: {
        enabled: false,
        useWorktree: true,
        autoCleanup: true,
        strict: false,
    },
};
/** @deprecated Use DEFAULT_SCHEDULER_CONFIG */
export const DEFAULT_SUPERVISOR_CONFIG = DEFAULT_SCHEDULER_CONFIG;
//# sourceMappingURL=execution-types.js.map