import { z } from 'zod';
import type { OrchestrationDecomposition, OrchestrationPosition, OrchestrationStep, SessionState } from './schemas.js';
import { transitionMutationReceipt, type TransitionMutationOptions, type TransitionMutationResult } from './transition-receipts.js';
import type { SessionBundle } from './store.js';
export declare function chainStepId(index: number, command: string): string;
export declare const chainDefinitionSchema: z.ZodObject<{
    intent: z.ZodOptional<z.ZodString>;
    engine: z.ZodOptional<z.ZodEnum<{
        ralph: "ralph";
        manual: "manual";
        coordinator: "coordinator";
    }>>;
    quality_mode: z.ZodOptional<z.ZodEnum<{
        quick: "quick";
        standard: "standard";
        full: "full";
    }>>;
    auto_mode: z.ZodOptional<z.ZodBoolean>;
    steps: z.ZodArray<z.ZodObject<{
        command: z.ZodString;
        args: z.ZodOptional<z.ZodString>;
        stage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        goal_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        retry_max: z.ZodOptional<z.ZodNumber>;
        decision_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>;
    decision_points: z.ZodOptional<z.ZodArray<z.ZodObject<{
        point_id: z.ZodString;
        after_step_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        max_retries: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>;
    boundary_contract: z.ZodOptional<z.ZodObject<{
        in_scope: z.ZodArray<z.ZodString>;
        out_of_scope: z.ZodArray<z.ZodString>;
        constraints: z.ZodArray<z.ZodString>;
        definition_of_done: z.ZodString;
    }, z.core.$strict>>;
    position: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        lifecycle: z.ZodString;
        phase: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        phase_is_new: z.ZodOptional<z.ZodBoolean>;
        milestone: z.ZodOptional<z.ZodString>;
        planning_mode: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        passed_gates: z.ZodOptional<z.ZodArray<z.ZodString>>;
        scope_verdict: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>>;
    decomposition: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        execution_criteria: z.ZodOptional<z.ZodArray<z.ZodString>>;
        goals: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            goal: z.ZodString;
            boundary: z.ZodOptional<z.ZodString>;
            done_when: z.ZodOptional<z.ZodString>;
            evidence: z.ZodOptional<z.ZodString>;
            lifecycle: z.ZodOptional<z.ZodArray<z.ZodString>>;
            status: z.ZodEnum<{
                pending: "pending";
                superseded: "superseded";
                done: "done";
            }>;
            completion_confirmed: z.ZodOptional<z.ZodBoolean>;
            completed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            superseded_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            origin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, z.core.$strict>>>;
        changelog: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            timestamp: z.ZodString;
            change_type: z.ZodEnum<{
                modify: "modify";
                boundary: "boundary";
                add: "add";
                remove: "remove";
            }>;
            reason: z.ZodString;
            impact_assessment: z.ZodOptional<z.ZodObject<{
                risk_level: z.ZodEnum<{
                    low: "low";
                    medium: "medium";
                    high: "high";
                }>;
                invalidated_steps: z.ZodArray<z.ZodNumber>;
                new_steps_inserted: z.ZodNumber;
            }, z.core.$strict>>;
            before: z.ZodObject<{
                goals: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    goal: z.ZodString;
                    done_when: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                boundary_snippet: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
            after: z.ZodObject<{
                goals: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    goal: z.ZodString;
                    done_when: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                boundary_snippet: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>>;
    executor: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        platform: z.ZodString;
        cli_tool: z.ZodString;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type ChainDefinition = z.infer<typeof chainDefinitionSchema>;
export interface CreateChainSessionOpts {
    intent?: string;
    /** Optional explicit topic identity; without it topic_identity stays null. */
    topic?: string;
    engine?: 'ralph' | 'coordinator' | 'manual';
    qualityMode?: 'quick' | 'standard' | 'full';
    autoMode?: boolean;
    boundaryContract?: SessionState['boundary_contract'];
    executor?: NonNullable<SessionState['orchestration']['executor']>;
    definition?: ChainDefinition;
}
export interface CreateChainSessionResult {
    sessionId: string;
    sessionDir: string;
    session: SessionState;
}
/**
 * Derive a session id from a slug, aligning with the ralph convention
 * `ralph-{YYYYMMDD-HHmmss}`: the slug replaces the fixed prefix. A slug that
 * already looks like a full session id (contains a 14-digit timestamp tail) is
 * used verbatim so callers can pin an explicit id.
 */
export declare function deriveSessionId(slug: string): string;
/**
 * Create a Session from an optional predefined chain definition. Engine may be
 * ralph / coordinator / manual. When no definition is supplied an empty-chain
 * session is created (intent only). The session id is derived from `slug` unless
 * an explicit id is passed.
 */
export declare function createChainSession(projectRoot: string, slug: string, opts?: CreateChainSessionOpts): CreateChainSessionResult;
export interface InsertChainStepOpts {
    after: string;
    command: string;
    args?: string;
    stage?: string | null;
    goalRef?: string | null;
    insertedBy: string;
    decisionRef?: string | null;
    transition?: Partial<TransitionMutationOptions>;
}
export type ChainMutation = {
    operation: 'insert';
    options: InsertChainStepOpts;
} | {
    operation: 'skip';
    stepId: string;
} | {
    operation: 'replace';
    stepId: string;
    options: ReplaceChainStepOpts;
};
/** Apply exactly one chain edit to an in-memory authority draft. */
export declare function applyChainMutation(bundle: SessionBundle, mutation: ChainMutation): OrchestrationStep;
/**
 * Insert a new pending step after the `after` step (step_id or index). The
 * insertion slot must be inside the still-pending tail: inserting before any
 * completed / running / sealed / skipped step is rejected. Inserting after the
 * active step (the fix-loop case) is allowed.
 */
export declare function insertChainStep(projectRoot: string, sessionId: string, opts: InsertChainStepOpts): TransitionMutationResult<OrchestrationStep>;
/**
 * Skip a pending chain step. Only `pending` steps may be skipped — completed /
 * running / sealed / already-skipped steps are rejected. `skipped` is a free
 * status string (the step status field is not a closed enum), and chain.ts's
 * nextPendingIndex selects only `status === 'pending'`, so a skipped step is
 * naturally excluded from step driving.
 */
export declare function skipChainStep(projectRoot: string, sessionId: string, stepId: string, transition?: Partial<TransitionMutationOptions>): TransitionMutationResult<OrchestrationStep>;
export interface ReplaceChainStepOpts {
    command?: string;
    args?: string;
    stage?: string | null;
    goalRef?: string | null;
    transition?: Partial<TransitionMutationOptions>;
}
/**
 * Replace fields of a pending chain step in place. Only `pending` steps may be
 * replaced. When `command` changes the step_id is regenerated at the step's
 * current index to keep the `step-{NNN}-{command}` convention consistent.
 */
export declare function replaceChainStep(projectRoot: string, sessionId: string, stepId: string, opts: ReplaceChainStepOpts): TransitionMutationResult<OrchestrationStep>;
export interface MetaUpdateOpts {
    /** Parsed JSON validated against positionSchema; null clears the block. */
    position?: OrchestrationPosition | null;
    /** Parsed JSON validated against decompositionSchema; null clears the block. */
    decomposition?: OrchestrationDecomposition | null;
    transition?: Partial<TransitionMutationOptions>;
}
export interface MetaUpdateResult {
    session_id: string;
    updated: Array<'position' | 'decomposition'>;
    position: OrchestrationPosition | null;
    decomposition: OrchestrationDecomposition | null;
    transition: ReturnType<typeof transitionMutationReceipt>;
}
/** Apply an integral meta replacement to an in-memory authority draft. */
export declare function applyMetaMutation(bundle: SessionBundle, opts: MetaUpdateOpts): Omit<MetaUpdateResult, 'transition'>;
/**
 * Parse + validate a caller-supplied position block against positionSchema. The
 * error is surfaced verbatim to the CLI so a malformed block reports the exact
 * offending field rather than a whole-session parse failure.
 */
export declare function parsePositionInput(raw: unknown): OrchestrationPosition;
/** Parse + validate a caller-supplied decomposition block against decompositionSchema. */
export declare function parseDecompositionInput(raw: unknown): OrchestrationDecomposition;
/**
 * Integral-replace orchestration.position and/or orchestration.decomposition.
 * The single write入口 for goal-audit / task_decomposition status flips /
 * goal_changelog appends — the prompt layer rebuilds the whole block and submits
 * it here rather than editing session.json directly. At least one block must be
 * provided (enforced by the caller). Blocks are validated by the caller via
 * parsePositionInput / parseDecompositionInput before this replaces them; the
 * transition transaction re-parse is the final guard.
 */
export declare function updateSessionMeta(projectRoot: string, sessionId: string, opts: MetaUpdateOpts): MetaUpdateResult;
//# sourceMappingURL=chain-admin.d.ts.map