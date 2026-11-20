// ---------------------------------------------------------------------------
// LLM Decider — thin spawn+parse wrapper for decision-node routing. Never
// throws; any failure returns null so the walker falls through to its own
// default (picks `default` edge or fails the session).
//
// Prompt assembly is the walker's job (main flow). This module only:
//   1. Sends a pre-assembled prompt via SpawnFn
//   2. Parses the DECISION: / REASONING: response
//   3. Validates the chosen target is in the closed valid-target set
//
// Mirrors the GeminiStepAnalyzer pattern: plain-text I/O, regex extraction,
// strict validation, graceful fallback on any error.
// ---------------------------------------------------------------------------
export class DefaultLLMDecider {
    spawnFn;
    agentType;
    workDir;
    constructor(spawnFn, opts = {}) {
        this.spawnFn = spawnFn;
        this.agentType = opts.agentType ?? 'gemini';
        this.workDir = opts.workDir ?? process.cwd();
    }
    async decide(req) {
        if (req.valid_targets.length === 0)
            return null;
        if (!req.prompt || req.prompt.trim().length === 0)
            return null;
        try {
            const result = await this.spawnFn({
                type: this.agentType,
                prompt: req.prompt,
                workDir: this.workDir,
                approvalMode: 'suggest',
            });
            return parseDecision(result.output, req.valid_targets);
        }
        catch (err) {
            console.error(`[llm-decider] decide() failed for node ${req.node_id}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }
}
// ---------------------------------------------------------------------------
// Output parsing — exported so the walker can reuse the exact same format
// contract used when it builds the prompt.
// ---------------------------------------------------------------------------
export function parseDecision(output, validTargets) {
    const decisionMatch = output.match(/DECISION:\s*(\S+)/);
    if (!decisionMatch)
        return null;
    const target = decisionMatch[1].trim().replace(/[,.;]+$/, '');
    if (!validTargets.includes(target))
        return null;
    const reasoningMatch = output.match(/REASONING:\s*(.+)/);
    const reasoning = reasoningMatch ? reasoningMatch[1].trim() : '';
    return { target, reasoning };
}
//# sourceMappingURL=llm-decider.js.map