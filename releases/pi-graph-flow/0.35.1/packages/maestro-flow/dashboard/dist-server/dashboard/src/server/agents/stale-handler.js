// ---------------------------------------------------------------------------
// createStaleHandler — shared StreamMonitor.onStale cascade for stream adapters
// ---------------------------------------------------------------------------
import { killProcessTree } from './process-tree-kill.js';
/**
 * Builds the `StreamMonitor` onStale callback shared by all stream adapters.
 *
 * On stale: log → close stdin (let it exit naturally) → after 5s escalate to a
 * process-tree SIGTERM → after 3s SIGKILL → after 2s force-emit stopped if the
 * OS ignored the signals (Windows). This mirrors the original
 * claude-code-adapter cascade so gemini/qwen/codex/opencode now terminate
 * consistently and kill the whole tree instead of leaking orphaned grandchildren.
 */
export function createStaleHandler(opts) {
    const { child, timeoutMs, onStaleDetected, isStopped, emitStopped } = opts;
    return () => {
        const secs = Math.round(timeoutMs / 1000);
        onStaleDetected(`Stream stale: no output for ${secs}s`);
        // Close stdin to signal the process to exit naturally.
        if (child.stdin?.writable) {
            child.stdin.end();
        }
        // Escalate only if it still hasn't stopped on its own.
        setTimeout(() => {
            if (isStopped())
                return;
            killProcessTree(child.pid, 'SIGTERM');
            setTimeout(() => {
                if (isStopped())
                    return;
                killProcessTree(child.pid, 'SIGKILL');
                // Last resort: kill signals ignored (Windows) — force a stopped event.
                setTimeout(() => {
                    emitStopped('Force stopped (stale stream fallback)');
                }, 2000);
            }, 3000);
        }, 5000);
    };
}
//# sourceMappingURL=stale-handler.js.map