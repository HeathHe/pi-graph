/**
 * Phase Types - TeamPhase enum, transition rules, and gate configuration
 * for the Phase Orchestrator.
 *
 * Defines the canonical set of team workflow phases, the valid transitions
 * between them, and configuration for phase-gate evaluation.
 */
// ---------------------------------------------------------------------------
// TeamPhase enum
// ---------------------------------------------------------------------------
export var TeamPhase;
(function (TeamPhase) {
    TeamPhase["planning"] = "planning";
    TeamPhase["execution"] = "execution";
    TeamPhase["review"] = "review";
    TeamPhase["verification"] = "verification";
    TeamPhase["fix"] = "fix";
    TeamPhase["complete"] = "complete";
})(TeamPhase || (TeamPhase = {}));
// ---------------------------------------------------------------------------
// TRANSITIONS map
// ---------------------------------------------------------------------------
/**
 * Valid phase transitions.
 * Key = source phase, Value = array of allowed target phases with retry limits.
 *
 * Main flow: planning -> execution -> review -> verification -> complete
 * Fix loop:  verification -> fix -> review (max 3 fix retries)
 */
export const TRANSITIONS = new Map([
    [TeamPhase.planning, [{ to: TeamPhase.execution, maxRetries: null }]],
    [TeamPhase.execution, [{ to: TeamPhase.review, maxRetries: null }]],
    [TeamPhase.review, [{ to: TeamPhase.verification, maxRetries: null }]],
    [TeamPhase.verification, [
            { to: TeamPhase.complete, maxRetries: null },
            { to: TeamPhase.fix, maxRetries: null },
        ]],
    [TeamPhase.fix, [{ to: TeamPhase.review, maxRetries: 3 }]],
    [TeamPhase.complete, []],
]);
//# sourceMappingURL=phase-types.js.map