import { type GuidanceSnapshot, type TransitionReceiptV20 } from '../protocol-schemas.js';
import { type KnowledgeReconciliation } from '../../knowledge/reconcile.js';
import { type ArtifactRegistry, type RunV30, type SessionStateV30 } from '../schemas.js';
import { SessionStore } from '../store.js';
import { type GoalMode } from '../goal-mode.js';
import { type V3NextContract, type V3TaskContract } from './continuation-v3.js';
import { type RunStatus, type RunTransitionEvidence } from './run-machine.js';
export interface V3MutationIdentity {
    sessionId: string;
    requestId: string;
    actorId: string;
    reason: string;
    evidenceRefs?: readonly string[];
    recordedAt?: string;
}
export interface V3MutationResult {
    status: 'applied' | 'replayed';
    transition: TransitionReceiptV20;
}
export interface MutateRunV3Input extends V3MutationIdentity {
    runId: string;
    expectedRunRevision: number;
    expectedOrchestrationRevision?: number;
    toStatus: RunStatus;
    summary?: string | null;
    verdict?: RunV30['verdict'];
    transitionEvidence?: RunTransitionEvidence;
}
export interface CreateRunV3Input extends V3MutationIdentity {
    expectedOrchestrationRevision: number;
    run: RunV30;
}
export interface CreateRunningRunV3Input extends CreateRunV3Input {
    requestOperation?: 'run-create' | 'run-next';
}
export interface CompleteRunAndAdvanceInput extends V3MutationIdentity {
    runId: string;
    expectedRunRevision: number;
    expectedOrchestrationRevision: number;
    summary?: string | null;
    verdict: Extract<NonNullable<RunV30['verdict']>, 'done' | 'done_with_concerns'>;
    /**
     * Optional preflight receipt derived by the CLI. Completion revalidates it
     * under the v3 store lock and regenerates it there when it is stale.
     * Deliberately NOT part of the canonical payload: replay returns the original
     * receipt before any derived knowledge work runs.
     */
    knowledgeReconciliation?: KnowledgeReconciliation | null;
}
export interface RecoverSealRunV3Input extends V3MutationIdentity {
    runId: string;
    expectedRunRevision: number;
}
export interface RebindRunV3Input extends V3MutationIdentity {
    runId: string;
    expectedRunRevision: number;
}
export interface RepublishArtifactV3Input extends V3MutationIdentity {
    artifactId: string;
    consumerCommand: string;
    alias: string;
    assessmentHash: string;
    expectedArtifactRevision: number;
    expectedSessionRevision: number;
}
export interface CompleteSessionV3Input extends V3MutationIdentity {
    expectedOrchestrationRevision: number;
}
export declare function mutateRunV3(store: SessionStore, input: MutateRunV3Input): V3MutationResult;
export declare function rebindRunV3(store: SessionStore, input: RebindRunV3Input): V3MutationResult;
export declare function recoverSealRunV3(store: SessionStore, input: RecoverSealRunV3Input): V3MutationResult;
export declare function createRunV3(store: SessionStore, input: CreateRunV3Input): V3MutationResult;
export declare function createRunningRunV3(store: SessionStore, input: CreateRunningRunV3Input): V3MutationResult;
/**
 * v3 birth packet — the executor-facing payload emitted by `run next`/`run create`.
 * Mirrors the v2 NextResult essentials (run_dir/upstream/guidance/knowledge/brief)
 * so a v3 executor can execute without an extra round trip; replaying the same
 * request-id returns the identical packet via the persisted receipt.
 */
export interface V3BirthPacket extends V3NextContract {
    run_id: string;
    run_dir: string;
    step_id: string;
    status: RunStatus;
    revision: number;
    /** Immutable execution inputs copied from the canonical Run. */
    task: V3TaskContract;
    /** Consumed artifacts resolved from the Session artifact registry (by id). */
    upstream: Record<string, {
        artifact_id: string;
        path: string;
        kind: string;
        status: 'sealed' | 'draft';
    }>;
    /** Command guidance snapshot (prepare/workflow/run-mode hashes); null when no source resolves. */
    guidance: GuidanceSnapshot | null;
    /**
     * Native-host Goal instructions when prepare declares `goal: true`.
     * Cursor host (`CURSOR_AGENT=1`) gets Cursor /goal rules, not Claude's paste prompt.
     */
    goal_mode: GoalMode | null;
    /** Knowledge delta handle; candidates are staged by `run complete`, so this may be empty at birth. */
    knowledge_context: {
        path: string;
        revision: number;
        candidate_count: number;
    } | null;
    brief: {
        command: string;
    };
    /** Explicit invariant preventing executors from allocating a duplicate Run. */
    run_already_created: true;
}
export declare function buildV3GuidanceSnapshot(store: SessionStore, command: string): GuidanceSnapshot | null;
export declare function v3BirthPacket(store: SessionStore, session: SessionStateV30, run: RunV30, artifacts: ArtifactRegistry): V3BirthPacket;
export declare function completeRunAndAdvance(store: SessionStore, input: CompleteRunAndAdvanceInput): V3MutationResult;
export declare function republishArtifactV3(store: SessionStore, input: RepublishArtifactV3Input): V3MutationResult;
export declare function completeSessionV3(store: SessionStore, input: CompleteSessionV3Input): V3MutationResult;
//# sourceMappingURL=mutation-engine.d.ts.map