import type { ChildProcess } from 'node:child_process';
export interface StaleHandlerOptions {
    /** Owning process id (for logging only — callbacks already close over it). */
    processId: string;
    /** The spawned CLI child process. */
    child: ChildProcess;
    /** Configured silence window (ms) — used for the human-readable message. */
    timeoutMs: number;
    /** Emit the stale error entry (e.g. EntryNormalizer.error → emitEntry). */
    onStaleDetected: (message: string) => void;
    /** True once a `stopped` status has already been emitted for this process. */
    isStopped: () => boolean;
    /** Force-emit a stopped status (Windows fallback when signals are ignored). */
    emitStopped: (reason: string) => void;
}
/**
 * Builds the `StreamMonitor` onStale callback shared by all stream adapters.
 *
 * On stale: log → close stdin (let it exit naturally) → after 5s escalate to a
 * process-tree SIGTERM → after 3s SIGKILL → after 2s force-emit stopped if the
 * OS ignored the signals (Windows). This mirrors the original
 * claude-code-adapter cascade so gemini/qwen/codex/opencode now terminate
 * consistently and kill the whole tree instead of leaking orphaned grandchildren.
 */
export declare function createStaleHandler(opts: StaleHandlerOptions): () => void;
