/**
 * Absolute ceiling on the cliff threshold and the score floor (the admission
 * gate). One overwhelming top file must not silence every peer the floor
 * admitted — the cliff is a RELATIVE prune of weak evidence, not a second
 * admission gate.
 */
export declare const SCORE_FLOOR_MAX = 10;
/**
 * Allocation constants. Each is a knob, not a magic number — see the comments
 * for what each pins and what breaks if it moves. Re-tuning is a visible
 * decision; the test suite pins the live values.
 */
export declare const EXPLORE_ALLOCATION: {
    /**
     * A file whose weight is under this fraction of the top file's gets no source.
     * Relative — size-independent. Generated CRUD lands at 10-11% and must cliff;
     * a genuine flow callee lands at 25% and must NOT. Between is a judgement the
     * agent can undo for ~0 cost (a cliffed file is still NAMED).
     */
    readonly CLIFF_FRACTION: 0.15;
    /** Ceiling on the cliff, same units as SCORE_FLOOR_MAX. */
    readonly CLIFF_MAX: 10;
    /**
     * Floor on a useful reservation — every admitted file gets this much before the
     * proportional split divides the rest. Below it a slice can't hold one complete
     * method and forces the Read this tool exists to prevent. Re-tuned down from
     * codegraph's 700 for Maestro's smaller envelope.
     */
    readonly MIN_CHARS: 400;
    /** Safety valve against a single god-file (the proportional split is primary). */
    readonly MAX_SHARE: 0.65;
    /** Markdown overhead per rendered file (header + fences + blanks). */
    readonly FILE_OVERHEAD: 200;
    /** Flow-spine files are weighted ×2 and are exempt from the cliff. */
    readonly SPINE_WEIGHT_BOOST: 2;
    /** Sliver a file may exceed its reservation and still ship whole. */
    readonly WHOLE_FILE_GRACE_FRACTION: 0.15;
    readonly WHOLE_FILE_GRACE_MAX: 800;
    /** Reservation covering ≥ this fraction of a file BUYS the whole file (CG-21). */
    readonly WHOLE_FILE_BUY_FRACTION: 0.6;
    /** The buy overshoot is funded from ONE shared pool = this fraction of envelope. */
    readonly WHOLE_FILE_BUY_OVERSHOOT_FRACTION: 0.15;
};
/**
 * The envelope split among admitted files. `maxOutputChars` bounds the
 * RESERVATIONS; the render loop may overshoot by a bounded grace (CG-14 hard
 * ceiling = min(maxOutputChars × 1.5, 25000)).
 */
export interface ExploreOutputBudget {
    /** Total reservation pool. Σ allowances ≤ this, exactly. */
    maxOutputChars: number;
    /** Max files admitted (per-tier). */
    maxFiles: number;
    /** Flat per-file cap (survives only as the pre-allocation guard / MAX_SHARE clamp). */
    maxCharsPerFile: number;
}
/**
 * One candidate file's allocation inputs, in FINAL RANK ORDER. `candidates`
 * passed to {@link allocateExploreBudget} must already be sorted by the ranking
 * pass — `maxFiles` is applied to the cliff survivors in that order, so
 * cliffing genuinely hands a slot to the next file down.
 */
export interface ExploreAllocationCandidate {
    path: string;
    /** Post-rankPenalty relevance score from the ranking pass. */
    score: number;
    /**
     * How much this file's BYTES are worth, independent of how well it matched
     * (0-1). Generated CRUD can rank on name-collision while its bytes stay
     * mechanical — rankPenalty applied a SECOND time here finally sinks it.
     */
    worth: number;
    /** Carries a symbol on the rendered flow spine (exempt from cliff, ×2 weight). */
    spine: boolean;
}
/** Result of allocating one envelope across a ranked candidate set. */
export interface ExploreAllocation {
    /** path → chars of source it may render. Only holds admitted files. */
    allowances: Map<string, number>;
    /** Files the cliff zeroed, in rank order — pointers, not bytes. */
    cliffed: string[];
    /** The weight threshold the cliff fired at (0 when nothing was cliffed). */
    cliffAt: number;
    /** Chars actually split among the admitted files (≤ maxOutputChars). */
    pool: number;
}
/**
 * Resolve the output budget for a project of `fileCount` indexed files.
 * The tier invariant (monotonic maxCharsPerFile) is asserted at module load.
 */
export declare function getExploreOutputBudget(fileCount: number): ExploreOutputBudget;
/**
 * Split `budget.maxOutputChars` across ranked candidates in proportion to
 * relevance, with a hard relative cliff.
 *
 * Invariant: Σ allowances ≤ pool ≤ budget.maxOutputChars, exactly.
 * Invariant: a larger tier never allows less per file than a smaller one.
 *
 * Algorithm (mirrors codegraph CG-12):
 *   1. weight(c) = max(0,score) × max(0,min(1,worth)) × (spine ? 2 : 1)
 *   2. cliff = min(topWeight × 0.15, 10); files under it (and not spine) → pointer
 *   3. admit up to maxFiles survivors (cliff frees the slot for the next file down)
 *   4. affordability trim: cliff lowest-weight files if envelope can't afford MIN_CHARS each
 *   5. pool = maxOutputChars − FILE_OVERHEAD × admitted
 *      allowance = floor(MIN_CHARS-each) + floor(remainder × weight/total), clamped to MAX_SHARE
 */
export declare function allocateExploreBudget(candidates: readonly ExploreAllocationCandidate[], budget: ExploreOutputBudget, maxFiles?: number): ExploreAllocation;
/**
 * The grace bound: a file within this many chars over its reservation still
 * ships WHOLE (slicing the sliver saves ~1% envelope and costs a Read).
 */
export declare function wholeFileGraceBound(reservation: number): number;
/**
 * CG-21 buy rule: should a reservation that already covers most of a file buy
 * the WHOLE file? MERIT reads the reservation (not post-carry allowance);
 * FUNDING reads the shared overshoot pool with `owedBelow`. Three independent
 * tests, kept apart — borrowed slack can never promote a weak file to whole.
 */
export declare function shouldBuyWholeFile(reservation: number, fileSize: number, sourceSpent: number, reservedTotal: number, maxOutputChars: number): boolean;
//# sourceMappingURL=allocation.d.ts.map