// ---------------------------------------------------------------------------
// Parallel Executor — Bridge between GraphWalker fork/join and ParallelCliRunner.
// Wraps ParallelCliRunner.runAll() behind a GraphWalker-friendly interface.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// AgentType -> tool name mapping (reverse of parallel-cli-runner)
// ---------------------------------------------------------------------------
const AGENT_TYPE_TO_TOOL = {
    gemini: 'gemini',
    qwen: 'qwen',
    codex: 'codex',
    'claude-code': 'claude',
    opencode: 'opencode',
    pi: 'pi',
    grok: 'grok',
};
// ---------------------------------------------------------------------------
// DefaultParallelExecutor
// ---------------------------------------------------------------------------
export class DefaultParallelExecutor {
    runner;
    constructor(runner) {
        this.runner = runner;
    }
    async executeBranches(branches, joinStrategy, signal) {
        const tasks = branches.map((b) => ({
            id: b.branchId,
            prompt: b.prompt,
            tool: AGENT_TYPE_TO_TOOL[b.agentType] ?? 'gemini',
            workDir: b.workDir,
            mode: 'write',
        }));
        const { results } = await this.runner.runAll(tasks, {
            joinStrategy,
            signal,
        });
        return results.map((r) => ({
            branchId: r.id,
            success: r.success,
            output: r.output,
            durationMs: r.durationMs,
        }));
    }
}
//# sourceMappingURL=parallel-executor.js.map