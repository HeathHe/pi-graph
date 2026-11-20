export interface WorkflowArtifacts {
    brainstorm: boolean;
    analysis: boolean;
    context: boolean;
    plan: boolean;
    verification: boolean;
    uat: boolean;
}
export interface WorkflowSnapshot {
    initialized: boolean;
    currentPhase: number;
    phaseStatus: string;
    artifacts: WorkflowArtifacts;
    execution: {
        tasksCompleted: number;
        tasksTotal: number;
    };
    verification: string;
    uat: string;
    phasesTotal: number;
    phasesCompleted: number;
    hasBlockers: boolean;
    accumulatedContext: string[];
    progressSummary: string;
    suggestedNextAction: string;
    readiness: 'ready' | 'blocked' | 'needs_input' | 'unknown';
}
export interface ClassifiedIntent {
    taskType: string;
    confidence: number;
    chainName: string;
    steps: Array<{
        cmd: string;
        args: string;
    }>;
    reasoning: string;
    clarificationNeeded: boolean;
    clarificationQuestion: string | null;
}
export interface StepAnalysis {
    qualityScore: number;
    executionAssessment: string;
    issues: string[];
    nextStepHints: string;
    stepSummary: string;
}
export type CoordinateProgressListener = (event: {
    phase: string;
    message: string;
    data?: unknown;
}) => void;
