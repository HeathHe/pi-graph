/**
 * Phase Gate Evaluator — computes whether a phase is ready to be marked complete.
 *
 * Called by transition-recorder before appending a transition entry.
 * Returns a structured result indicating whether completion is allowed,
 * with reasons for blocking and whether --force can override.
 */
export interface GateResult {
    /** Whether the phase may be marked complete */
    allowed: boolean;
    /** Human-readable reasons for blocking */
    reasons: string[];
    /** Whether --force can override (false when review verdict is BLOCK) */
    overridable: boolean;
}
/** Subset of phase index.json fields consumed by the evaluator */
export interface PhaseGateInput {
    review?: {
        verdict?: string;
        findings_count?: number;
    };
    verification?: {
        status?: string;
        gaps?: Array<{
            id?: string;
            severity?: string;
            description?: string;
        }>;
    };
    validation?: {
        status?: string;
        test_coverage?: {
            statements?: number;
            branches?: number;
            functions?: number;
            lines?: number;
        } | number | null;
    };
}
/**
 * Evaluate whether a phase is ready to transition to `completed`.
 * Pure function — no I/O.
 */
export declare function evaluatePhaseGate(phase: PhaseGateInput): GateResult;
//# sourceMappingURL=phase-gate-evaluator.d.ts.map