// ---------------------------------------------------------------------------
// CLI Executor — CommandExecutor implementation for the Graph Coordinator.
// Delegates process spawning to an injected SpawnFn, keeping this module
// decoupled from adapter implementations (dashboard package boundary).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CliExecutor
// ---------------------------------------------------------------------------
export class CliExecutor {
    spawn;
    abortController = null;
    constructor(spawn) {
        this.spawn = spawn;
    }
    async execute(request) {
        this.abortController = new AbortController();
        const startTime = Date.now();
        try {
            const result = await this.spawn({
                type: request.agent_type,
                prompt: request.prompt,
                workDir: request.work_dir,
                approvalMode: request.approval_mode,
                signal: this.abortController.signal,
            });
            return {
                success: result.success,
                raw_output: result.output,
                exec_id: result.execId,
                duration_ms: result.durationMs,
            };
        }
        catch (err) {
            return {
                success: false,
                raw_output: err instanceof Error ? err.message : String(err),
                exec_id: '',
                duration_ms: Date.now() - startTime,
            };
        }
        finally {
            this.abortController = null;
        }
    }
    async abort() {
        this.abortController?.abort();
    }
}
//# sourceMappingURL=cli-executor.js.map