/**
 * Phase Orchestrator - Structured team phase management.
 *
 * Manages phase transitions with guard evaluation, fix retry counting,
 * state broadcast via team-msg, and transition persistence.
 */
import { TeamPhase, type PhaseGateConfig, type PhaseStatus } from './phase-types.js';
export interface TransitionResult {
    success: boolean;
    from: TeamPhase;
    to: TeamPhase;
    /** Non-empty when success=false, explains why the transition was rejected */
    reason?: string;
    /** Gate evaluation reasons (populated even on success if gates were soft-blocked and forced) */
    gateReasons: string[];
}
export declare class PhaseOrchestrator {
    private readonly sessionId;
    private _currentPhase;
    private _fixAttempts;
    private readonly _history;
    constructor(sessionId: string);
    /** Current phase of the team workflow */
    get currentPhase(): TeamPhase;
    /** Number of fix attempts in the current fix loop */
    get fixAttempts(): number;
    /**
     * Attempt to transition to `targetPhase`.
     *
     * Steps:
     * 1. Validate the transition exists in TRANSITIONS map
     * 2. Check fix retry limit for fix->review transitions
     * 3. Evaluate phase-gate guard (if gateConfig provided)
     * 4. Apply the transition, update counters, record history
     * 5. Broadcast state_update via team-msg opLog
     * 6. Persist transition to transitions.jsonl
     */
    transitionTo(targetPhase: TeamPhase, options?: {
        trigger?: string;
        force?: boolean;
        gateConfig?: PhaseGateConfig;
        /** Callback to broadcast via team-msg (decoupled from direct import) */
        broadcast?: (sessionId: string, phase: TeamPhase, fixAttempts: number) => void;
    }): TransitionResult;
    getPhaseStatus(): PhaseStatus;
    private applyTransition;
    /**
     * Append transition record to {run_dir}/work/team/transitions.jsonl.
     * Legacy team session IDs retain their former storage location.
     */
    private persistTransition;
}
//# sourceMappingURL=phase-orchestrator.d.ts.map