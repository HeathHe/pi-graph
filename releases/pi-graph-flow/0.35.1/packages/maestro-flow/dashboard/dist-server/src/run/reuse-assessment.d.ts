export type ReuseDecision = 'REUSE' | 'REVIEW' | 'CONFLICT' | 'REJECT';
export type ProducerStatus = 'created' | 'running' | 'blocked' | 'failed' | 'completed' | 'sealed';
export type ArtifactStatus = 'draft' | 'sealed' | 'invalid' | 'superseded';
export type ContractDrift = 'none' | 'prompt_only' | 'compatible_output' | 'breaking' | 'unknown';
export type FreshnessStatus = 'fresh' | 'compatible' | 'stale' | 'unknown';
export type QualityStatus = 'high' | 'medium' | 'low' | 'unknown';
export type SupersessionStatus = 'current' | 'superseded' | 'unknown';
export type ReuseReasonCode = 'PRODUCER_NOT_SEALED' | 'ARTIFACT_INVALID' | 'ARTIFACT_SUPERSEDED' | 'ARTIFACT_NOT_SEALED' | 'SOURCE_FENCE_INCOMPLETE' | 'ARTIFACT_HASH_UNVERIFIED' | 'ARTIFACT_HASH_MISMATCH' | 'ARTIFACT_SCHEMA_UNKNOWN' | 'ARTIFACT_SCHEMA_MISMATCH' | 'ARTIFACT_SCHEMA_MAJOR_COMPATIBLE' | 'ARTIFACT_ROLE_MISMATCH' | 'CONTRACT_BREAKING_DRIFT' | 'CONTRACT_PROMPT_ONLY_DRIFT' | 'CONTRACT_COMPATIBLE_OUTPUT' | 'CONTRACT_COMPATIBILITY_UNKNOWN' | 'CONTRACT_HASH_MISMATCH' | 'FRESHNESS_COMPATIBLE' | 'FRESHNESS_STALE' | 'FRESHNESS_UNKNOWN' | 'QUALITY_LOW' | 'QUALITY_MEDIUM' | 'QUALITY_UNKNOWN' | 'SUPERSESSION_UNKNOWN' | 'SUPERSEDED_BY_NEWER_ARTIFACT' | 'SAME_ROLE_COMPARISON_UNKNOWN' | 'SAME_ROLE_CONFLICT' | 'REUSE_ELIGIBLE';
export interface ExecutionSealReceiptAnchor {
    execution_id: string;
    generation: number;
    sealed_at: string;
    relative_path: string;
    overall_hash: string;
}
export interface ReuseCandidate {
    workspaceId: string;
    sessionId: string;
    producerRunId: string;
    producerRunHash: string | null;
    producerStatus: ProducerStatus;
    artifactId: string;
    artifactRole: string;
    artifactStatus: ArtifactStatus;
    artifactHash: string | null;
    observedArtifactHash: string | null;
    artifactSchema: string | null;
    artifactRegistryRevision: number | null;
    executionSealReceipt?: ExecutionSealReceiptAnchor | null;
    executionSourceRequired?: boolean;
}
export interface ReuseContractEvidence {
    producerHash: string | null;
    currentHash: string | null;
    drift: ContractDrift;
}
export interface ReuseQualityEvidence {
    status: QualityStatus;
    concernCodes: readonly string[];
}
export interface ReuseSupersessionEvidence {
    status: SupersessionStatus;
    supersedesArtifactIds: readonly string[];
    supersededByArtifactIds: readonly string[];
}
export interface SameRoleReuseCandidate {
    artifactId: string;
    artifactHash: string | null;
    eligible: boolean;
}
export interface ReuseConflictEvidence {
    sameRoleCandidates: readonly SameRoleReuseCandidate[];
}
export interface ReuseAssessmentInput {
    candidate: ReuseCandidate;
    consumer?: {
        kind: string;
        alias: string | null;
        schema: string | null;
        role: 'primary' | 'attachment' | 'evidence' | 'checkpoint' | null;
    };
    acceptedArtifactSchemas: readonly string[];
    acceptedSchemaRanges?: readonly string[];
    acceptedArtifactRoles?: readonly string[];
    contract: ReuseContractEvidence;
    freshness: FreshnessStatus;
    quality: ReuseQualityEvidence;
    supersession: ReuseSupersessionEvidence;
    conflicts: ReuseConflictEvidence;
}
export interface ReuseSourceFenceV10 {
    schema_version: 'reuse-source-fence/1.0';
    workspace_id: string;
    session_id: string;
    producer_run_id: string;
    producer_run_hash: string | null;
    producer_status: ProducerStatus;
    artifact_id: string;
    artifact_role: string;
    artifact_status: ArtifactStatus;
    artifact_hash: string | null;
    observed_artifact_hash: string | null;
    artifact_schema: string | null;
    artifact_registry_revision: number | null;
    producer_contract_hash: string | null;
}
export interface ReuseSourceFenceV11 extends Omit<ReuseSourceFenceV10, 'schema_version'> {
    schema_version: 'reuse-source-fence/1.1';
    execution_seal_receipt: ExecutionSealReceiptAnchor;
}
export type ReuseSourceFence = ReuseSourceFenceV10;
export type ReuseSourceFenceRead = ReuseSourceFenceV10 | ReuseSourceFenceV11;
export interface ReuseAssessment {
    schema_version: 'reuse-assessment/1.0';
    decision: ReuseDecision;
    reason_codes: ReuseReasonCode[];
    consumer: {
        kind: string;
        alias: string | null;
        schema: string | null;
        role: 'primary' | 'attachment' | 'evidence' | 'checkpoint' | null;
    };
    source_fence: ReuseSourceFenceV10;
    assessment_hash: string;
}
export interface ReuseAssessmentV11 extends Omit<ReuseAssessment, 'schema_version' | 'source_fence'> {
    schema_version: 'reuse-assessment/1.1';
    source_fence: ReuseSourceFenceV11;
}
export type ReuseAssessmentRead = ReuseAssessment | ReuseAssessmentV11;
export type SchemaMatchResult = 'unknown' | 'exact' | 'major-compatible' | 'mismatch';
/**
 * Single implementation of consume-schema matching, shared by the main
 * assessment and same-role candidate eligibility.
 *
 * Exact mode (acceptedSchemas): byte-equal match, unchanged semantics.
 * Range mode (acceptedSchemaRanges, `<kind>/<major>.x`): accepts any
 * producer schema of the same kind and major; it is an explicit
 * compatibility commitment by the consumer author, never a runtime
 * inference. A producer schema that does not parse as `<kind>/<major>.<minor>`
 * is treated as unknown, not auto-completed.
 */
export declare function schemaMatch(artifactSchema: string | null, acceptedSchemas: readonly string[], acceptedSchemaRanges?: readonly string[]): SchemaMatchResult;
/**
 * Pure, read-only eligibility assessment. It neither copies artifacts nor
 * changes Session/Run state; callers separately decide how to act on the result.
 */
export declare function assessArtifactReuse(input: ReuseAssessmentInput & {
    candidate: ReuseCandidate & {
        executionSealReceipt: ExecutionSealReceiptAnchor;
    };
}): ReuseAssessmentV11;
export declare function assessArtifactReuse(input: ReuseAssessmentInput): ReuseAssessment;
