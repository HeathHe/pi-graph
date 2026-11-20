import { z } from 'zod';
import { type CompleteNextSuggestion } from './runtime.js';
import { type TransitionMutationReceipt } from './transition-receipts.js';
export declare const planPublishRunInputSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"plan-publish-input/1.0">;
    request_id: z.ZodString;
    handoff_key: z.ZodString;
    source_checksum: z.ZodString;
    source_pi_session: z.ZodNullable<z.ZodString>;
    plan_revision: z.ZodNumber;
    approved_at: z.ZodString;
    expected_identity_revision: z.ZodNumber;
    expected_activity_revision: z.ZodNumber;
    lease: z.ZodObject<{
        execution_owner: z.ZodNullable<z.ZodString>;
        owner_epoch: z.ZodNullable<z.ZodNumber>;
        lease_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
declare const executionOwnerKindSchema: z.ZodEnum<{
    claude: "claude";
    codex: "codex";
    pi: "pi";
    agy: "agy";
    manual: "manual";
}>;
export declare const planPublishExecutionRunInputSchema: z.ZodObject<{
    request_id: z.ZodString;
    approved_at: z.ZodString;
    expected_identity_revision: z.ZodNumber;
    expected_activity_revision: z.ZodNumber;
    handoff_key: z.ZodString;
    source_checksum: z.ZodString;
    source_pi_session: z.ZodNullable<z.ZodString>;
    plan_revision: z.ZodNumber;
    schema_version: z.ZodLiteral<"plan-publish-input/1.1">;
    execution: z.ZodObject<{
        execution_id: z.ZodString;
        generation: z.ZodNumber;
        expected_revision: z.ZodNumber;
    }, z.core.$strict>;
    claim: z.ZodObject<{
        owner_id: z.ZodString;
        owner_kind: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
            agy: "agy";
            manual: "manual";
        }>;
        epoch: z.ZodNumber;
        lease_id_hash: z.ZodString;
    }, z.core.$strict>;
    audit: z.ZodObject<{
        actor: z.ZodString;
        reason: z.ZodString;
        evidence: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const planPublishInputReadSchema: z.ZodUnion<readonly [z.ZodObject<{
    request_id: z.ZodString;
    approved_at: z.ZodString;
    expected_identity_revision: z.ZodNumber;
    expected_activity_revision: z.ZodNumber;
    handoff_key: z.ZodString;
    source_checksum: z.ZodString;
    source_pi_session: z.ZodNullable<z.ZodString>;
    plan_revision: z.ZodNumber;
    schema_version: z.ZodLiteral<"plan-publish-input/1.1">;
    execution: z.ZodObject<{
        execution_id: z.ZodString;
        generation: z.ZodNumber;
        expected_revision: z.ZodNumber;
    }, z.core.$strict>;
    claim: z.ZodObject<{
        owner_id: z.ZodString;
        owner_kind: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            pi: "pi";
            agy: "agy";
            manual: "manual";
        }>;
        epoch: z.ZodNumber;
        lease_id_hash: z.ZodString;
    }, z.core.$strict>;
    audit: z.ZodObject<{
        actor: z.ZodString;
        reason: z.ZodString;
        evidence: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    schema_version: z.ZodLiteral<"plan-publish-input/1.0">;
    request_id: z.ZodString;
    handoff_key: z.ZodString;
    source_checksum: z.ZodString;
    source_pi_session: z.ZodNullable<z.ZodString>;
    plan_revision: z.ZodNumber;
    approved_at: z.ZodString;
    expected_identity_revision: z.ZodNumber;
    expected_activity_revision: z.ZodNumber;
    lease: z.ZodObject<{
        execution_owner: z.ZodNullable<z.ZodString>;
        owner_epoch: z.ZodNullable<z.ZodNumber>;
        lease_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>]>;
export type LegacyPlanPublishRunInput = z.infer<typeof planPublishRunInputSchema>;
export type ExecutionPlanPublishRunInput = z.infer<typeof planPublishExecutionRunInputSchema>;
export type PlanPublishRunInput = z.infer<typeof planPublishInputReadSchema>;
export interface PublishPlanOptions {
    projectRoot: string;
    sourcePath: string;
    sourceRoot?: string;
    sessionId?: string;
    intent?: string;
    topic?: string;
    handoffKey: string;
    sourcePiSession?: string;
    planRevision?: number;
    approvedAt?: string;
    expectedIdentityRevision?: number;
    expectedActivityRevision?: number;
    requestId?: string;
    executionId?: string;
    generation?: number;
    expectedExecutionRevision?: number;
    executionOwner?: string;
    ownerKind?: z.infer<typeof executionOwnerKindSchema>;
    ownerEpoch?: number;
    leaseId?: string;
    actor?: string;
    reason?: string;
    evidence?: string[];
}
export interface PublishPlanHooks {
    afterExecutionChainBootstrapped?: (target: {
        sessionId: string;
        executionId: string;
        transitionId: string;
    }) => void;
    afterRunCreated?: (target: {
        sessionId: string;
        runId: string;
    }) => void;
}
export interface LegacyPublishPlanResult {
    schema_version: 'plan-publish-result/1.0';
    session_id: string;
    run_id: string;
    artifact_id: string;
    artifact_path: string;
    handoff_key: string;
    source_checksum: string;
    request_id: string;
    created_session: boolean;
    replayed: boolean;
    transition: TransitionMutationReceipt;
    next: CompleteNextSuggestion;
}
export interface ExecutionPublishPlanResult extends Omit<LegacyPublishPlanResult, 'schema_version'> {
    schema_version: 'plan-publish-result/1.1';
    execution_id: string;
    generation: number;
    execution_revision: number;
    session_identity_revision: number;
    session_activity_revision: number;
    lease_epoch: number;
    claim: {
        owner_id: string;
        owner_kind: z.infer<typeof executionOwnerKindSchema>;
        epoch: number;
        lease_id_hash: string;
    };
}
export type PublishPlanResult = LegacyPublishPlanResult | ExecutionPublishPlanResult;
export declare function derivePlanPublishRequestId(handoffKey: string): string;
export declare function automaticSessionId(requestId: string): string;
/**
 * Plan/1.0 artifact bytes for the `pi-markdown` external-approval variant.
 * Shared by the legacy plan publisher and the v3 plan-publish producer Run
 * so both emit byte-identical `outputs/plan.json` for the same approval.
 */
export declare function planArtifactBytes(input: {
    handoff_key: string;
    source_checksum: string;
    source_pi_session: string | null;
    revision: number;
    approved_at: string;
}, markdown: string): Buffer;
export declare function publishPlan(options: PublishPlanOptions, hooks?: PublishPlanHooks): PublishPlanResult;
export {};
//# sourceMappingURL=plan-publish.d.ts.map