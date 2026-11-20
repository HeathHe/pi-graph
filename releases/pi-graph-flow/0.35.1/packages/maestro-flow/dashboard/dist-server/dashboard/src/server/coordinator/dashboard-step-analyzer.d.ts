import type { CommandNode, WalkerContext, AssembleRequest, AnalysisResult, StepAnalyzer } from '../../../../src/coordinator/graph-types.js';
import type { QualityReviewerAgent } from './agents/quality-reviewer-agent.js';
export declare class DashboardStepAnalyzer implements StepAnalyzer {
    private readonly qualityReviewer;
    constructor(qualityReviewer: QualityReviewerAgent);
    analyze(node: CommandNode, rawOutput: string, _ctx: WalkerContext, _prevCmd?: AssembleRequest['previous_command']): Promise<AnalysisResult>;
}
