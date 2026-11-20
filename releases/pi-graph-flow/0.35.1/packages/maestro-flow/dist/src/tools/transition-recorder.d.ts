/**
 * Transition Recorder — Records phase/milestone transitions in state.json
 *
 * Provides pure functions for building transition entries and appending
 * them to the transition_history array in .workflow/state.json.
 */
import type { TransitionEntry } from '../utils/state-schema.js';
export type { TransitionSnapshot, TransitionEntry } from '../utils/state-schema.js';
export interface BuildTransitionOpts {
    type: 'phase' | 'milestone';
    fromPhase: number | null;
    toPhase: number | null;
    milestone: string;
    trigger: string;
    force: boolean;
    phasesCompleted: number;
    phasesTotal: number;
    deferredCount: number;
    verificationStatus: string;
    learningsCount: number;
}
/**
 * Build a transition entry from the given parameters.
 * Pure function — no I/O.
 */
export declare function buildTransitionEntry(opts: BuildTransitionOpts): TransitionEntry;
/**
 * Append a transition entry to state.json's transition_history[].
 * Creates the array if it doesn't exist.
 *
 * For phase-completion transitions, evaluates the phase gate first.
 * Throws if the gate blocks and force is false.
 */
export declare function appendTransition(statePath: string, entry: TransitionEntry): void;
//# sourceMappingURL=transition-recorder.d.ts.map