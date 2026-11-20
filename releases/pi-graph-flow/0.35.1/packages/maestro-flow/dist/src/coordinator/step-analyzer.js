// ---------------------------------------------------------------------------
// Step Analyzer — Optional quality analysis via gemini after each command step.
// Never throws; analysis failure returns a safe default result.
// ---------------------------------------------------------------------------
const MAX_OUTPUT_CHARS = 4000;
const DEFAULT_RESULT = {
    quality_score: 50,
    issues: ['Analysis parsing failed'],
    next_step_hints: {},
};
export class GeminiStepAnalyzer {
    spawnFn;
    constructor(spawnFn) {
        this.spawnFn = spawnFn;
    }
    async analyze(node, rawOutput, _ctx, prevCmd) {
        const outputTail = rawOutput.length > MAX_OUTPUT_CHARS
            ? rawOutput.slice(-MAX_OUTPUT_CHARS)
            : rawOutput;
        const prevLine = prevCmd
            ? `Previous step: ${prevCmd.cmd} (${prevCmd.outcome})`
            : 'Previous step: none';
        const prompt = [
            'Analyze the following maestro command output.',
            '',
            `Command: ${node.cmd}${node.args ? ' ' + node.args : ''}`,
            prevLine,
            '',
            'Output (last 4000 chars):',
            outputTail,
            '',
            'Return a JSON block with this exact format:',
            '```json',
            '{',
            '  "quality_score": <0-100>,',
            '  "issues": ["issue1", "issue2"],',
            '  "next_step_hints": {',
            '    "prompt_additions": "suggestions for next step",',
            '    "cautions": ["caution1"],',
            '    "context_to_carry": "key context"',
            '  }',
            '}',
            '```',
        ].join('\n');
        try {
            const result = await this.spawnFn({
                type: 'gemini',
                prompt,
                workDir: process.cwd(),
                approvalMode: 'suggest',
            });
            return parseAnalysis(result.output);
        }
        catch {
            return { ...DEFAULT_RESULT };
        }
    }
}
// ---------------------------------------------------------------------------
// JSON extraction from gemini output
// ---------------------------------------------------------------------------
function parseAnalysis(output) {
    const match = output.match(/```json\s*([\s\S]*?)```/);
    if (!match)
        return { ...DEFAULT_RESULT };
    try {
        const parsed = JSON.parse(match[1].trim());
        if (typeof parsed.quality_score !== 'number' ||
            !Array.isArray(parsed.issues)) {
            return { ...DEFAULT_RESULT };
        }
        return {
            quality_score: parsed.quality_score,
            issues: parsed.issues,
            next_step_hints: (parsed.next_step_hints ?? {}),
        };
    }
    catch {
        return { ...DEFAULT_RESULT };
    }
}
//# sourceMappingURL=step-analyzer.js.map