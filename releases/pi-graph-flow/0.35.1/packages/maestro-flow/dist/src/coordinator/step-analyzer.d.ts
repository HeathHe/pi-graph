import type { AnalysisResult, AssembleRequest, CommandNode, StepAnalyzer, WalkerContext } from './graph-types.js';
import type { SpawnFn } from './cli-executor.js';
export declare class GeminiStepAnalyzer implements StepAnalyzer {
    private readonly spawnFn;
    constructor(spawnFn: SpawnFn);
    analyze(node: CommandNode, rawOutput: string, _ctx: WalkerContext, prevCmd?: AssembleRequest['previous_command']): Promise<AnalysisResult>;
}
//# sourceMappingURL=step-analyzer.d.ts.map