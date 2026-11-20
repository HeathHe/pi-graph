// ---------------------------------------------------------------------------
// DashboardStepAnalyzer -- thin adapter: StepAnalyzer → QualityReviewerAgent
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// DashboardStepAnalyzer
// ---------------------------------------------------------------------------
export class DashboardStepAnalyzer {
    qualityReviewer;
    constructor(qualityReviewer) {
        this.qualityReviewer = qualityReviewer;
    }
    async analyze(node, rawOutput, _ctx, _prevCmd) {
        // Convert CommandNode → CoordinateStep for QualityReviewerAgent
        const step = {
            index: 0,
            cmd: node.cmd,
            args: node.args ?? '',
            status: 'completed',
            processId: null,
            analysis: null,
            summary: null,
        };
        const analysis = await this.qualityReviewer.review(step, rawOutput);
        // Convert StepAnalysis (camelCase) → AnalysisResult (snake_case)
        return {
            quality_score: analysis.qualityScore,
            issues: analysis.issues,
            next_step_hints: {
                prompt_additions: analysis.nextStepHints || undefined,
            },
        };
    }
}
//# sourceMappingURL=dashboard-step-analyzer.js.map