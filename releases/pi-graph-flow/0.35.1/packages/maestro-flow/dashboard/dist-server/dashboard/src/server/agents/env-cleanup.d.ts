/**
 * Build a clean environment for spawning CLI child processes.
 * Strips Electron/npm lifecycle variables that can interfere with
 * child process behavior (e.g. NODE_OPTIONS set by Electron,
 * npm_lifecycle_event causing unexpected behavior in npx).
 */
export declare function cleanSpawnEnv(overrides?: Record<string, string | undefined>): Record<string, string | undefined>;
