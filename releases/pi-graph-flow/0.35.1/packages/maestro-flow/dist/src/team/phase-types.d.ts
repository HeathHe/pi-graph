/**
 * Phase Types - TeamPhase enum, transition rules, and gate configuration
 * for the Phase Orchestrator.
 *
 * Defines the canonical set of team workflow phases, the valid transitions
 * between them, and configuration for phase-gate evaluation.
 */
import type { PhaseGateInput } from '../tools/phase-gate-evaluator.js';
export declare enum TeamPhase {
    planning = "planning",
    execution = "execution",
    review = "review",
    verification = "verification",
    fix = "fix",
    complete = "complete"
}
export interface TransitionRule {
    /** Target phase */
    to: TeamPhase;
    /** Maximum consecutive transitions to this target (null = unlimited) */
    maxRetries: number | null;
}
/**
 * Valid phase transitions.
 * Key = source phase, Value = array of allowed target phases with retry limits.
 *
 * Main flow: planning -> execution -> review -> verification -> complete
 * Fix loop:  verification -> fix -> review (max 3 fix retries)
 */
export declare const TRANSITIONS: ReadonlyMap<TeamPhase, readonly TransitionRule[]>;
export interface PhaseGateConfig {
    /** Phase gate input for evaluation (review/verification/validation status) */
    gateInput: PhaseGateInput;
    /** Whether to allow force-overriding soft blocks */
    allowForceOverride: boolean;
}
export interface PhaseTransitionRecord {
    from: TeamPhase;
    to: TeamPhase;
    timestamp: string;
    trigger: string;
    force: boolean;
    gateReasons: string[];
}
export interface PhaseStatus {
    current: TeamPhase;
    fixAttempts: number;
    history: PhaseTransitionRecord[];
    nextTransitions: TeamPhase[];
}
//# sourceMappingURL=phase-types.d.ts.map