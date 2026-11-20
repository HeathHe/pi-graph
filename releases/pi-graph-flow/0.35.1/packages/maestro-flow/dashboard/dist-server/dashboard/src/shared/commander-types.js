// ---------------------------------------------------------------------------
// Commander Agent types — config, state, assessment, and decision interfaces
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------
export const DEFAULT_COMMANDER_CONFIG = {
    // Core Loop
    pollIntervalMs: 30_000,
    maxConcurrentWorkers: 3,
    stallTimeoutMs: 300_000,
    maxRetries: 2,
    retryBackoffMs: 60_000,
    // Decision
    decisionModel: 'sonnet',
    assessMaxTurns: 5,
    autoApproveThreshold: 'low',
    defaultExecutor: 'claude-code',
    // Safety
    safety: {
        eventDebounceMs: 5_000,
        circuitBreakerThreshold: 3,
        maxTicksPerHour: 120,
        maxTokensPerHour: 500_000,
        protectedPaths: ['.env', '.env.*', '*.key', '*.pem', 'credentials.*'],
    },
    // Workspace
    workspace: {
        enabled: false,
        useWorktree: true,
        autoCleanup: true,
        strict: false,
    },
    // Profile
    profile: 'development',
};
//# sourceMappingURL=commander-types.js.map