import { type Command, type CommanderError } from 'commander';
import type { ExecutionLeaseClaim } from '../run/lease.js';
import type { ResponseFenceV11, ResponseLocatorV11, ResponseWarningV11, RunOperationV11, RunResponseErrorCodeV11 } from '../run/protocol-schemas.js';
import type { ExecutionState } from '../run/schemas.js';
export declare const EXECUTION_OWNER_KINDS: readonly ["pi", "claude", "codex", "agy", "manual"];
export type ExecutionOwnerKind = typeof EXECUTION_OWNER_KINDS[number];
export interface ExecutionLocatorOptions {
    session: string;
    execution: string;
}
export interface ExecutionRevisionOptions extends ExecutionLocatorOptions {
    requestId: string;
    expectedExecutionRevision: number;
}
export interface ExecutionOwnerOptions {
    executionOwner?: string;
    /** @deprecated Use executionOwner / --execution-owner. */
    ownerId?: string;
    ownerKind: ExecutionOwnerKind;
}
export interface ExecutionLeaseOptions extends ExecutionOwnerOptions {
    ownerEpoch?: number;
    /** @deprecated Use ownerEpoch / --owner-epoch. */
    leaseEpoch?: number;
    leaseId: string;
}
export interface ExecutionAcquireOptions extends ExecutionOwnerOptions {
    expectedLeaseEpoch: number;
}
export interface ExecutionSessionCasOptions {
    expectedIdentityRevision?: number;
    expectedActivityRevision?: number;
}
export interface AuditedExecutionOptions {
    actor: string;
    reason: string;
    evidence: string[];
}
export interface ExecutionOutputOptions {
    json?: boolean;
    workflowRoot: string;
    claimOutput?: string;
}
export declare function parseNonNegativeInteger(value: string): number;
export declare function parsePositiveInteger(value: string): number;
export declare function parseOwnerKind(value: string): ExecutionOwnerKind;
/** Keep Commander machine errors useful without reflecting credential-bearing argv. */
export declare function sanitizeCommanderError(error: CommanderError, argv: readonly string[]): {
    message: string;
    details: {
        commander_code: string;
    };
};
export declare function addExecutionLocatorOptions(command: Command): Command;
export declare function addExecutionRevisionOptions(command: Command): Command;
export declare function addExecutionOwnerOptions(command: Command): Command;
export declare function addExecutionAcquireOptions(command: Command): Command;
export declare function addExecutionLeaseOptions(command: Command): Command;
export declare function addExecutionSessionCasOptions(command: Command, requirements: {
    identity?: boolean;
    activity?: boolean;
}): Command;
export declare function addAuditedExecutionOptions(command: Command): Command;
export declare function addExecutionOutputOptions(command: Command, acquisition?: boolean): Command;
export declare function executionLeaseClaim(options: ExecutionLeaseOptions): ExecutionLeaseClaim;
export declare function normalizedExecutionOwner(options: ExecutionOwnerOptions): string;
export declare function normalizedOwnerEpoch(options: ExecutionLeaseOptions): number;
export declare function executionLocator(execution: Pick<ExecutionState, 'session_id' | 'execution_id' | 'generation' | 'active_run_id'>): ResponseLocatorV11;
export declare function executionFence(projectRoot: string, execution: Pick<ExecutionState, 'session_id' | 'revision'> & {
    lease: {
        epoch: number;
    } | null;
}): ResponseFenceV11;
export declare function readExecutionAuthority(projectRoot: string, sessionId: string, executionId: string): {
    locator: ResponseLocatorV11;
    fence: ResponseFenceV11;
} | null;
export declare function emitExecutionSuccess(input: {
    operation: RunOperationV11;
    result: unknown;
    projectRoot: string;
    execution: Pick<ExecutionState, 'session_id' | 'execution_id' | 'generation' | 'active_run_id' | 'revision'> & {
        lease: {
            epoch: number;
        } | null;
    };
    requestId?: string | null;
    replay?: {
        replayed: boolean;
        transition_id: string;
    } | null;
    warnings?: ResponseWarningV11[];
}): void;
export declare function emitExecutionError(input: {
    operation: RunOperationV11;
    error: unknown;
    projectRoot: string;
    sessionId?: string;
    executionId?: string;
    requestId?: string | null;
    exitCode?: 1 | 2 | 3;
    disposition?: 'domain_error' | 'control_flow' | 'usage_error';
    code?: RunResponseErrorCodeV11;
    details?: Record<string, unknown>;
    warnings?: ResponseWarningV11[];
}): void;
export declare function prepareExecutionClaimOutput(claimOutput: string | undefined, projectRoot: string, secretField?: 'lease_claim' | 'handoff_token'): string;
export declare function printExecutionHuman(value: object, claimOutput?: string, secretField?: 'lease_claim' | 'handoff_token', projectRoot?: string): void;
export declare function reportExecutionHuman(error: unknown): void;
export declare function deprecationWarning(command: string, replacement: string): ResponseWarningV11;
//# sourceMappingURL=execution-cli-shared.d.ts.map