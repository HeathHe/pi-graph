import { type ArtifactScanResult, type DiscoveredArtifact } from './artifacts.js';
import { type CommandContract } from './contract.js';
import { type TargetPlatform } from '../core/skill-converter.js';
import { type InspectArtifactCompatibilityOptions, type PrepareArtifactRepublishOptions } from './artifact-compatibility.js';
import { type KnowledgeCandidateReceipt } from './knowledge.js';
import { reconciliationSummary, type KnowledgeReconciliation } from '../knowledge/reconcile.js';
import { type CommandRun, type ExecutionState, type Gate, type Handoff, type ReportFrontmatter, type SessionState, type SessionStateRead } from './schemas.js';
import { type ArtifactCompatibilityAssessment, type ArtifactRepublishReceipt, type BriefResult, type CompleteInputSnapshot, type CreationProvenance, type ExecutionContract, type ArgumentRequirement, type IntentIdentity, type SessionProvenance, type SourceFenceRead, type TransitionPointer } from './protocol-schemas.js';
import { type ValidatedChainProposal } from './chain-proposal.js';
import { type TopicIdentity } from './topic-identity.js';
import { type ReuseAssessmentRead } from './reuse-assessment.js';
import { SessionStore, type SessionBundle, type StoreTransaction } from './store.js';
import { type ExecutionLeaseClaim, type LeaseClaim } from './lease.js';
import { type TransitionMutationOptions, type TransitionMutationReceipt } from './transition-receipts.js';
import { type ProjectSessionEntry, type StateJsonV2 } from '../utils/state-schema.js';
export interface RunUpstream {
    artifact_id: string;
    path: string;
    kind: string;
    status: 'sealed' | 'draft';
}
/** Compact view of a prior Run's handoff, shared by next/brief/prepare read-sides. */
export interface PrevHandoff {
    run_id: string;
    command: string;
    verdict: Handoff['verdict'];
    summary: string;
    decisions: string[];
    concerns: string[];
}
/** Session anchor grounding block reused by brief (Intent / Boundary / Progress). */
export interface AnchorSection {
    intent: string | null;
    boundary_contract: string | null;
    progress: string | null;
    signals: string | null;
}
export interface NamedGateBlocker {
    gate_id: string;
    title: string;
    status: Gate['status'];
}
export type SessionProvenanceInput = Omit<SessionProvenance, 'forked_from' | 'imported_from'> & {
    forked_from: SourceFenceRead | null;
    imported_from: SourceFenceRead[];
};
export interface CreateRunOptions {
    projectRoot: string;
    command: string;
    sessionId?: string;
    intent?: string;
    /** Command-independent topic used for Session selection. Defaults to intent. */
    topic?: string;
    args?: string[];
    /** Explicit platform for first creation; persisted and immutable on re-attach. */
    platform?: TargetPlatform;
    /** Opaque token issued by a needs-retry transition. */
    retryToken?: string;
    /** Atomically bind the new Run to this pending chain step. */
    chainStepId?: string;
    /** Preflight revision from `run next`, revalidated inside the SessionStore lock. */
    expectedActivityRevision?: number;
    /** Preflight identity revision from `run next`, revalidated inside the SessionStore lock. */
    expectedIdentityRevision?: number;
    /** Lease claim validated and persisted with the chain binding. */
    leaseClaim?: LeaseClaim;
    /** Explicit execution binding; omitted legacy calls continue writing command-run/1.3. */
    execution?: {
        executionId: string;
        generation: number;
        expectedRevision: number;
        lease: ExecutionLeaseClaim;
        requestId: string;
        operation?: 'create' | 'next';
    };
    /** Require a running Session and atomically fence an ad-hoc Run allocation. */
    requireRunningSession?: boolean;
    /** Explicit exact identity supplied by recall/fork/import consumers. */
    intentIdentity?: IntentIdentity;
    /** Session lineage for a newly allocated Session. */
    sessionProvenance?: SessionProvenanceInput;
    /** Audited creation authority supplied by confirmation/transition consumers. */
    creation?: {
        requestId: string | null;
        mode: 'explicit-create' | 'chain-next' | 'retry' | 'resume' | 'fork' | 'import';
        authority: 'explicit-command' | 'chain-transition' | 'confirmation-token' | 'legacy-inferred';
        confirmationTokenHash: string | null;
        provenance: CreationProvenance;
        transition?: TransitionPointer | null;
    };
}
export interface CreateRunResult {
    session_id: string;
    run_id: string;
    run_dir: string;
    chain_step_id: string | null;
    resolved_platform: TargetPlatform;
    upstream: Record<string, RunUpstream>;
    topic_identity: TopicIdentity;
    reuse_assessments: ReuseAssessmentRead[];
    reuse_warnings: string[];
    argument_requirements: ArgumentRequirement[];
    entry_gates: GateSummary;
    entry_blockers: NamedGateBlocker[];
    session_created: boolean;
    next: {
        command: string;
        reason: string;
    };
}
export interface RebindRunResult {
    session_id: string;
    run_id: string;
    rebind_kind: 'legacy_contract_backfill' | 'compatible_contract_rebind' | 'prompt_only_rebind';
    old_content_hash: string;
    content_hash: string;
    old_contract_hash: string | null;
    contract_hash: string;
    old_snapshot_hash: string | null;
    snapshot_hash: string;
    audit_path: string;
}
export interface ArtifactRepublishResult {
    session_id: string;
    source_artifact_id: string;
    artifact_id: string;
    compatibility_run_id: string;
    compatibility_step_id: string;
    assessment_hash: string;
    artifact_registry_revision: number;
    session_revision: number;
    receipt: ArtifactRepublishReceipt;
    replay: {
        status: 'applied' | 'replayed';
        transition_id: string;
    };
}
export interface ArtifactRepublishOptions extends PrepareArtifactRepublishOptions {
}
export interface AcceptReuseResult {
    session_id: string;
    run_id: string;
    artifact_id: string;
    assessment_hash: string;
    run_status: CommandRun['status'];
    consumes: string[];
    entry_gates: GateSummary;
    transition: TransitionMutationReceipt;
}
export interface AcceptReuseOptions extends Partial<TransitionMutationOptions> {
    actor: string;
    reason: string;
    evidence: string[];
}
export interface SealSessionResult {
    session_id: string;
    status: 'sealed';
    sealed_at: string;
    run_count: number;
    knowledge: {
        pending_candidates: number;
        promoting_candidates: number;
        promoted_candidates: number;
        review_required_candidates: number;
        conflict_candidates: number;
        suppressed_candidates: number;
        review_command: string;
    };
}
export interface GateSummary {
    passed: string[];
    failed: string[];
    skipped: string[];
    blocking: string[];
}
export interface CheckRunResult {
    session_id: string;
    run_id: string;
    status: CommandRun['status'];
    gates: GateSummary;
    artifacts: Array<{
        path: string;
        kind: string;
        role: string;
        alias?: string;
    }>;
    warnings: string[];
    errors: string[];
    upstream: Record<string, RunUpstream>;
    reuse_assessments: ReuseAssessmentRead[];
    /** Populated by `run check`: repair loop while gates block, complete when clean, advance when sealed. */
    next?: {
        command: string;
        reason: string;
    };
    /**
     * Finish-work checklist, populated by `run check` only once every gate is
     * clean: core handoff/record/verdict norms plus workflow frontmatter
     * `finish:` lines. Prompt-layer guidance — never a blocking gate.
     */
    finish?: string[];
    /** Completion-preflight knowledge classification; promotion review remains separate. */
    knowledge_reconciliation?: ReturnType<typeof reconciliationSummary>;
    /** Diagnostic-only contract drift; no Run/gate/check marker writes occurred. */
    contract_drift?: {
        expected: string;
        current: string;
        mode: 'diagnostic';
    };
}
export interface CompleteRunResult extends CheckRunResult {
    sealed: boolean;
    primary_artifact_id: string | null;
    artifact_ids: string[];
    /** Suggest-only post-completion action; never allocates or executes another Run. */
    next_action?: CompleteNextSuggestion;
    /** Present when completeRun atomically applied a chain verdict. */
    chain_transition?: {
        step_id: string;
        index: number;
        step_status: string;
        retry: {
            count: number;
            max: number;
            exhausted: boolean;
        } | null;
    } | null;
    /** Proposal operations applied inside the same completion transition. */
    chain_proposal?: {
        proposal_id: string;
        path: string;
        status: 'applied';
        operations: Array<{
            op: string;
            target: string;
            status: string;
        }>;
    } | null;
    /** Candidate staging receipt; project knowledge still requires explicit review/promotion. */
    knowledge: (KnowledgeCandidateReceipt & {
        reconciliation: ReturnType<typeof reconciliationSummary>;
    }) | null;
    transition: TransitionMutationReceipt;
}
export interface PrepareConsumeStatus {
    alias: string | null;
    kind: string;
    required: boolean;
    present: boolean;
    status: 'sealed' | 'draft' | null;
    path: string | null;
}
export interface PreparePrevious {
    handoff: PrevHandoff | null;
    consumes: PrepareConsumeStatus[];
    upstream: Record<string, RunUpstream>;
    reuse_assessments: ReuseAssessmentRead[];
    selected_refs: Array<{
        alias: string;
        artifact_id: string;
        path: string;
        assessment_hash: string;
    }>;
}
export interface PrepareChainStepHint {
    index: number;
    step_id: string;
    command: string;
    status: SessionState['orchestration']['chain'][number]['status'];
    run_id: string | null;
    decision_ref: string | null;
}
export interface PrepareDecisionHint {
    point_id: string;
    after_step_id: string | null;
    status: SessionState['orchestration']['decision_points'][number]['status'];
    retry_count: number;
    max_retries: number;
    evidence_ref: string | null;
}
export interface PrepareSessionGuidance {
    session_id: string;
    status: SessionState['status'] | 'missing';
    active_run_id: string | null;
    latest_completed_run_id: string | null;
    current_step: PrepareChainStepHint | null;
    next_pending_step: PrepareChainStepHint | null;
    open_decisions: PrepareDecisionHint[];
    knowledge?: {
        unique_inputs: number;
        pending_candidates: number;
        corroborated_candidates: number;
        promoting_candidates: number;
        review_required_candidates: number;
        conflict_candidates: number;
        suppressed_candidates: number;
        missing_reconciliation_candidates: number;
        review_command: string;
    };
    reminders: string[];
    next: {
        command: string | null;
        reason: string;
    };
}
export interface PrepareStepResult {
    step: string;
    platform: string;
    prepare: {
        path: string;
        content: string;
    } | null;
    workflow: {
        path: string;
        line_count: number;
    } | null;
    run_mode: {
        path: string;
        summary: string;
    } | null;
    refs: Array<{
        path: string;
        when: string;
    }>;
    goal_mode: {
        platform: string;
        instructions: string;
    } | null;
    /** Present only when `sessionId` is supplied — read-only prior-step context. */
    previous?: PreparePrevious;
    /** Present only when `sessionId` is supplied — read-only chain and decision reminders. */
    session_guidance?: PrepareSessionGuidance;
}
export interface SkillContentResult {
    step: string;
    platform: string;
    prepare: {
        path: string;
        content: string;
    } | null;
    workflow: {
        path: string;
        content: string;
    } | null;
    refs: Array<{
        path: string;
        when: string;
    }>;
    goal_mode: {
        platform: string;
        instructions: string;
    } | null;
}
export type BriefRunResult = BriefResult;
export type ExecutionContractView = ExecutionContract;
export interface CompleteNextSuggestion {
    suggest_only: true;
    action: 'repair_run' | 'resolve_session' | 'dispatch_next' | 'evaluate_decision' | 'seal_session';
    command: string | null;
    reason: string;
    preconditions: string[];
}
export interface CheckRunOptions {
    /**
     * Diagnostic-only mode that downgrades contract kind/schema/role/alias mismatches
     * to warnings. Required outputs, artifact syntax, safe-path checks, and gates remain
     * blocking, and a bypassed check never authorizes completion.
     */
    skipArtifactMetadataValidation?: boolean;
}
export interface CompleteRunOptions {
    /**
     * When true, the caller asserts that `run check` already passed clean and
     * outputs/ has not been modified since. The completion engine may skip
     * gate re-evaluation (but still scans for artifact registration).
     * TODO: implement skip logic in prepareCompleteInputs.
     */
    checkClean?: boolean;
    /**
     * Compatibility-only caller input. Completion always validates artifact metadata
     * strictly; the warnings-only mode is diagnostic and belongs to `run check`.
     */
    skipArtifactMetadataValidation?: boolean;
    /** Extra concerns merged (append + dedupe) into the derived handoff. */
    notes?: string[];
    /** Run-relative paths registered as evidence artifacts beyond the outputs scan. */
    extraArtifacts?: string[];
    /**
     * Used as handoff.summary only when the report frontmatter yielded an empty
     * one. Report frontmatter stays the primary source; this is the CLI fallback
     * (e.g. ralph complete --summary when the executor wrote no frontmatter).
     */
    summaryFallback?: string;
    /**
     * CLI-supplied decisions appended to the derived handoff.decisions (status
     * `accepted`). Aligns ralph `--decisions` onto the P3 handoff single-source:
     * ralph parked them in ralph-meta; here they ride the run's handoff so the
     * next step's birth packet can surface them via prev_handoff.
     */
    decisions?: string[];
    /** Lease claim checked inside the same transaction that seals the Run. */
    leaseClaim?: LeaseClaim;
    /** Execution-bound completion authority; omitted legacy calls stay on transition/1.0. */
    execution?: {
        executionId: string;
        generation: number;
        expectedRevision: number;
        lease: ExecutionLeaseClaim;
        requestId: string;
    };
    /** Internal chain transition used by completeRunWithVerdict. */
    chainVerdict?: CompletionVerdict;
    /** Run-relative chain-proposal artifact selected for atomic application. */
    chainProposal?: string;
    /** Apply the single validated chain-proposal discovered in this Run. */
    applyChainProposal?: boolean;
    /** Audited retry/revision/lease authority for completion. */
    transition?: Partial<TransitionMutationOptions>;
    /** Require this Run to remain the active Run of a running Session until sealing. */
    requireRunningSession?: boolean;
}
/** Chain-advancement instruction carried by `run complete --verdict`. */
export type CompletionVerdict = 'done' | 'done-with-concerns' | 'needs-retry' | 'blocked';
export interface CompleteVerdictResult {
    session_id: string;
    run_id: string;
    verdict: CompletionVerdict;
    /** True when the run sealed (done / done-with-concerns / needs-retry paths). */
    run_sealed: boolean;
    /** The chain step this run was bound to, or null for a non-chain run. */
    chain: {
        step_id: string;
        index: number;
        /** The chain step's status after the verdict was applied. */
        step_status: string;
        /** Retry counter after a needs-retry bump (null otherwise). */
        retry: {
            count: number;
            max: number;
            exhausted: boolean;
        } | null;
    } | null;
    /** Session status after the verdict (paused on blocked, unchanged otherwise). */
    session_status: SessionState['status'];
    /** Next-step pointer closing the loop back to `run next` / decide / seal. */
    next: CompleteNextSuggestion;
    /** The underlying seal result (run gates, artifacts, warnings, errors). */
    seal: CompleteRunResult;
}
export declare function projectSessionEntry(session: SessionState, authority?: SessionStateRead): ProjectSessionEntry;
/** Read-only command-independent topic lookup used by prepare and recall. */
export declare function resolveTopicSessionId(projectRoot: string, topic: string, requested?: string): string | null;
interface CollectedReuse {
    upstream: Record<string, RunUpstream>;
    assessments: ReuseAssessmentRead[];
}
export declare function assessSessionReuse(projectRoot: string, sessionId: string, command: string): CollectedReuse;
/**
 * Explicitly accept one REVIEW assessment. The receipt binds the exact
 * assessment hash and source fence; run.input.consumes is updated in the same
 * authority transaction, so an Artifact Registry candidate alone never opens
 * the required consume gate.
 */
export declare function acceptRunReuse(projectRoot: string, runId: string, assessmentHash: string, sessionId: string | undefined, options: AcceptReuseOptions): AcceptReuseResult;
export declare function inspectArtifactForConsumer(projectRoot: string, options: InspectArtifactCompatibilityOptions): ArtifactCompatibilityAssessment;
/** Session/1.x and statusless session/2.0 compatibility writer adapter. */
export declare function republishArtifactLegacy(projectRoot: string, options: ArtifactRepublishOptions): ArtifactRepublishResult;
export declare function resolveArgumentRequirements(projectRoot: string, command: string, args: string[]): ArgumentRequirement[];
/**
 * Flag-like arguments that match no declared definition. Used to enrich
 * missing/invalid-argument errors so a typo is not silently swallowed.
 */
export declare function resolveUnknownFlags(projectRoot: string, command: string, args: string[]): string[];
export declare function createRun(options: CreateRunOptions): CreateRunResult;
export interface CreateExecutionRunOptions extends Omit<CreateRunOptions, 'execution'> {
    executionId: string;
    generation: number;
    expectedExecutionRevision: number;
    executionLease: ExecutionLeaseClaim;
    requestId: string;
    transitionOperation?: 'create' | 'next';
}
/** Execution-aware create; legacy createRun remains an unleased command-run/1.3 API. */
export declare function createExecutionRun(options: CreateExecutionRunOptions): CreateRunResult;
export declare function checkRun(projectRoot: string, runId: string, sessionId?: string, options?: CheckRunOptions): CheckRunResult;
export declare function rebindRunCommand(projectRoot: string, runId: string, reason: string, sessionId?: string): RebindRunResult;
export declare function sealSession(projectRoot: string, sessionId: string, summary?: string): SealSessionResult;
interface PreparedCompleteFile {
    path: string;
    hash: string | null;
}
export interface PreparedCompleteInputs {
    projectRoot: string;
    sessionId: string;
    runId: string;
    runDir: string;
    sessionDir: string;
    store: SessionStore;
    contract: CommandContract;
    warning: string | null;
    scan: ArtifactScanResult;
    extraArtifacts: DiscoveredArtifact[];
    frontmatter: ReportFrontmatter;
    state: StateJsonV2;
    options: CompleteRunOptions;
    files: PreparedCompleteFile[];
    completionInputSnapshot: CompleteInputSnapshot;
    chainProposal: ValidatedChainProposal | null;
    knowledgeReconciliation: KnowledgeReconciliation;
}
type CompleteAuthorityResult = Omit<CompleteRunResult, 'transition'>;
/** Prepare report/output/state inputs and immutable hashes outside the transition lock. */
export declare function prepareCompleteInputs(projectRoot: string, runId: string, sessionId: string | undefined, options: CompleteRunOptions): PreparedCompleteInputs;
/** Apply complete authority using only the prepared inputs and StoreTransaction. */
export declare function applyCompleteRunMutation(draft: SessionBundle, tx: StoreTransaction, prepared: PreparedCompleteInputs, executionOverride?: ExecutionState): {
    result: CompleteAuthorityResult;
    run: CommandRun;
};
export declare function completeRun(projectRoot: string, runId: string, sessionId?: string, options?: CompleteRunOptions): CompleteRunResult;
export interface CompleteExecutionRunOptions extends Omit<CompleteRunOptions, 'execution'> {
    sessionId: string;
    executionId: string;
    generation: number;
    expectedExecutionRevision: number;
    executionLease: ExecutionLeaseClaim;
    requestId: string;
}
/** Execution-aware completion with command-run/1.4 binding and full lease fencing. */
export declare function completeExecutionRun(projectRoot: string, runId: string, options: CompleteExecutionRunOptions): CompleteRunResult;
export interface CompleteVerdictOptions extends CompleteRunOptions {
    /** Chain-advancement instruction. Defaults to `done`. */
    verdict?: CompletionVerdict;
    /** Reason text (blocked) merged into the handoff concerns, ralph `--reason`. */
    reason?: string;
}
/**
 * `run complete` with a chain-advancement verdict — the generic-layer equivalent
 * of `ralph complete <idx> --status <S>`. All four verdicts first run the
 * standard seal path (completeRun: derive handoff + register artifacts + seal the
 * Run), so run.json is sealed regardless of the chain outcome. The verdict then
 * drives the bound chain step:
 *
 *   done / done-with-concerns → step `sealed`   (terminal; matches next.ts
 *                                                 reconcileSealedSteps)
 *   needs-retry               → step `pending`, run_id cleared, retry.count++
 *   blocked                   → step `failed`,  session `paused`
 *
 * A non-chain Run (no chain step bound to its run_id) still seals and carries its
 * signals via the handoff, but the chain and session status are left untouched —
 * the verdict is advisory there, never an error.
 *
 * Signals ride the handoff (P3 single-source): reason (blocked) and an auto
 * done-with-concerns note fold into notes → handoff.concerns; decisions append to
 * handoff.decisions; evidence paths register as extra artifacts. No handoff
 * schema field is added — the verdict itself lives only in the chain transition.
 */
export declare function completeRunWithVerdict(projectRoot: string, runId: string, sessionId: string, options?: CompleteVerdictOptions): CompleteVerdictResult;
export declare function summarizeRunMode(raw: string): string;
export declare function prepareStep(projectRoot: string, stepName: string, platform?: TargetPlatform, sessionId?: string): PrepareStepResult;
export declare function skillContent(projectRoot: string, stepName: string, platform?: TargetPlatform): SkillContentResult;
export declare function briefRun(projectRoot: string, runId: string, sessionId?: string, platform?: TargetPlatform): BriefRunResult;
/**
 * Register a Session in state.json's projections (sessions[] + active_session_id)
 * for creation paths that do not go through a successful createRun (`session
 * create`, `session start --no-dispatch`). Reads the freshest committed state and
 * upserts, so concurrent registrations do not clobber each other's entries
 * (the read-modify-write window stays tiny; there is no cross-process CAS).
 * Returns a warning string when the registration could not be persisted, or null.
 */
export declare function ensureSessionProjectionOnDisk(projectRoot: string, sessionId: string, makeActive?: boolean): string | null;
/**
 * Find (and optionally remove) orphan Session directories — directories under
 * .workflow/sessions/ that have no state.json projection and no Runs. These are
 * the shells left behind by failed first dispatches or manual copies; they are
 * invisible to canonical resolution and accumulate silently. `apply` deletes
 * them; otherwise the call is a dry-run. Dangling projections (registered in
 * state.json but missing on disk) are also reported and, with `apply`, pruned,
 * since they make canonical resolution fail with a dead-lock.
 */
export declare function pruneOrphanSessions(projectRoot: string, apply: boolean): {
    orphans: string[];
    removed: string[];
    dangling: string[];
    pruned: string[];
};
export {};
//# sourceMappingURL=runtime.d.ts.map