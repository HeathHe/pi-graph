import type { AgentType, LLMDecider, LLMDecisionRequest, LLMDecisionResult } from './graph-types.js';
import type { SpawnFn } from './cli-executor.js';
export interface DefaultLLMDeciderOptions {
    agentType?: AgentType;
    workDir?: string;
}
export declare class DefaultLLMDecider implements LLMDecider {
    private readonly spawnFn;
    private readonly agentType;
    private readonly workDir;
    constructor(spawnFn: SpawnFn, opts?: DefaultLLMDeciderOptions);
    decide(req: LLMDecisionRequest): Promise<LLMDecisionResult | null>;
}
export declare function parseDecision(output: string, validTargets: string[]): LLMDecisionResult | null;
//# sourceMappingURL=llm-decider.d.ts.map