import type { CoordinateStep } from '../../../shared/coordinate-types.js';
import type { StepAnalysis } from '../types.js';
export declare class QualityReviewerAgent {
    review(step: CoordinateStep, output: string): Promise<StepAnalysis>;
}
