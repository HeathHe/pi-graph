/**
 * Monitors stream activity and fires a callback when no activity is detected
 * for longer than `maxSilenceMs`. Prevents zombie processes from hanging
 * indefinitely when the CLI child process stops producing output.
 *
 * Default silence window is 10 minutes: long write-mode tasks (large builds,
 * test suites) can legitimately produce no stdout for minutes. Callers may
 * override via the constructor (threaded from `--timeout` / cli-tools.json).
 */
/** Default stale-stream silence window (10 min) — single source of truth. */
export declare const DEFAULT_STREAM_TIMEOUT_MS = 600000;
export declare class StreamMonitor {
    private readonly onStale;
    private lastActivity;
    private readonly maxSilence;
    private timer;
    private fired;
    constructor(onStale: () => void, maxSilenceMs?: number, checkIntervalMs?: number);
    /** Call on every stream activity (line received, entry emitted, etc.) */
    heartbeat(): void;
    dispose(): void;
}
