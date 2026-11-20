import { type ExecutionLeaseClaim, type ExecutionLeaseStatus } from './lease.js';
import { type ExecutionLease, type ExecutionState, type SessionState } from './schemas.js';
type OwnerKind = ExecutionLease['owner_kind'];
export interface AuditMetadata {
    actor: string;
    reason: string;
    evidence: readonly string[];
}
export interface ExecutionLocatorInput {
    sessionId: string;
    executionId: string;
}
export interface ExecutionMutationOptions extends ExecutionLocatorInput {
    requestId: string;
    expectedExecutionRevision: number;
    lease: ExecutionLeaseClaim;
    now?: Date;
}
export interface AuditedExecutionMutationOptions extends ExecutionMutationOptions, Partial<AuditMetadata> {
}
export interface UnleasedExecutionMutationOptions extends ExecutionLocatorInput {
    requestId: string;
    expectedExecutionRevision: number;
    now?: Date;
}
export interface AuditedUnleasedExecutionMutationOptions extends UnleasedExecutionMutationOptions, Partial<AuditMetadata> {
}
export interface ExecutionLeaseAcquisition {
    owner_id: string;
    owner_kind: OwnerKind;
    epoch: number;
    lease_id: string;
}
export type PublicExecutionState = Omit<ExecutionState, 'lease'> & {
    lease: Omit<ExecutionLease, 'lease_id'> | null;
};
export interface ExecutionResult {
    execution: PublicExecutionState;
    replayed: boolean;
    transition_id: string;
}
export interface BootstrapExecutionChainOptions extends ExecutionLocatorInput, AuditMetadata {
    requestId: string;
    generation: number;
    expectedIdentityRevision: number;
    expectedActivityRevision: number;
    expectedExecutionRevision: number;
    lease: ExecutionLeaseClaim;
    now?: Date;
}
export interface StartExecutionOptions extends Partial<AuditMetadata> {
    executionId?: string;
    requestId: string;
    ownerId: string;
    ownerKind: OwnerKind;
    expectedIdentityRevision?: number;
    expectedActivityRevision?: number;
    expectedLeaseEpoch?: number;
    now?: Date;
}
export interface StartExecutionResult extends ExecutionResult {
    lease_claim: ExecutionLeaseAcquisition;
}
export interface UnavailableExecutionAcquisitionResult extends ExecutionResult {
    lease_claim: null;
    credential_status: 'superseded' | 'released' | 'different_current_claim';
    recovery_instruction: string;
}
export type ReplayableExecutionAcquisitionResult = StartExecutionResult | UnavailableExecutionAcquisitionResult;
export interface AttachExecutionOptions extends ExecutionLocatorInput {
    requestId: string;
    expectedExecutionRevision: number;
    ownerId: string;
    ownerKind: OwnerKind;
    now?: Date;
}
export interface ExecutionStatusResult {
    session_status: SessionState['status'];
    execution: Omit<ExecutionState, 'lease'> & {
        lease: ExecutionLeaseStatus['lease'];
    };
    lease: ExecutionLeaseStatus;
}
export type ExecutionResolutionTarget = {
    kind: 'decision';
    id: string;
    disposition: 'proceed' | 'retry';
} | {
    kind: 'step';
    id: string;
    disposition: 'retry' | 'skip';
};
export interface ResolveExecutionOptions extends AuditedUnleasedExecutionMutationOptions {
    target: ExecutionResolutionTarget;
}
export interface ResumeExecutionOptions extends AuditedUnleasedExecutionMutationOptions {
    ownerId: string;
    ownerKind: OwnerKind;
    expectedActivityRevision?: number;
    expectedLeaseEpoch?: number;
}
export interface SealExecutionOptions extends AuditedExecutionMutationOptions {
    summary: string;
    outcome: 'done' | 'done_with_concerns' | 'failed';
    expectedActivityRevision?: number;
    staleAfterMs?: number;
}
export interface RecoverExecutionLeaseOptions extends ExecutionLocatorInput, Partial<AuditMetadata> {
    requestId: string;
    expectedExecutionRevision: number;
    ownerId: string;
    ownerKind: OwnerKind;
    expectedLeaseEpoch?: number;
    staleAfterMs?: number;
    now?: Date;
}
export interface PrepareExecutionHandoffOptions extends AuditedExecutionMutationOptions {
    toOwnerId: string;
}
export interface PrepareExecutionHandoffResult extends ExecutionResult {
    handoff_token: string | null;
    credential_status: 'issued' | 'already_applied';
    recovery: 'none' | 'cancel_and_prepare_new';
}
export interface AcceptExecutionHandoffOptions extends ExecutionLocatorInput, Partial<AuditMetadata> {
    requestId: string;
    expectedExecutionRevision: number;
    ownerId: string;
    ownerKind: OwnerKind;
    handoffToken: string;
    expectedLeaseEpoch?: number;
    now?: Date;
}
export declare class ExecutionLeaseReleaseBlockedError extends Error {
    readonly blockers: readonly string[];
    readonly code: "LEASE_RELEASE_BLOCKED";
    constructor(blockers: readonly string[]);
}
export declare function startExecution(projectRoot: string, sessionId: string, options: StartExecutionOptions): StartExecutionResult;
export declare function bootstrapExecutionChain(projectRoot: string, options: BootstrapExecutionChainOptions): ExecutionResult;
export declare function executionStatus(projectRoot: string, sessionId: string, executionId?: string, options?: {
    now?: Date;
    staleAfterMs?: number;
}): ExecutionStatusResult;
export declare function attachExecution(projectRoot: string, options: AttachExecutionOptions): ReplayableExecutionAcquisitionResult;
export declare function pauseExecution(projectRoot: string, options: AuditedExecutionMutationOptions): ExecutionResult;
export declare function resolveExecution(projectRoot: string, options: ResolveExecutionOptions): ExecutionResult;
export declare function resumeExecution(projectRoot: string, options: ResumeExecutionOptions): ReplayableExecutionAcquisitionResult;
export declare function sealExecution(projectRoot: string, options: SealExecutionOptions): ExecutionResult;
export declare function heartbeatExecutionLease(projectRoot: string, options: ExecutionMutationOptions): ExecutionResult;
export declare function releaseExecutionLease(projectRoot: string, options: ExecutionMutationOptions): ExecutionResult;
export declare function recoverExecutionLease(projectRoot: string, options: RecoverExecutionLeaseOptions): ReplayableExecutionAcquisitionResult;
export declare function prepareExecutionHandoff(projectRoot: string, options: PrepareExecutionHandoffOptions): PrepareExecutionHandoffResult;
export declare function acceptExecutionHandoff(projectRoot: string, options: AcceptExecutionHandoffOptions): ReplayableExecutionAcquisitionResult;
export declare function cancelExecutionHandoff(projectRoot: string, options: AuditedExecutionMutationOptions): ExecutionResult;
export {};
//# sourceMappingURL=execution.d.ts.map