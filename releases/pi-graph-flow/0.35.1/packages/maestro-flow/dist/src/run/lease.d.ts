import type { ExecutionLease, OrchestrationLease } from './schemas.js';
export interface LeaseClaim {
    executionOwner?: string;
    ownerEpoch?: number;
    leaseId?: string;
}
export declare const DEFAULT_EXECUTION_LEASE_STALE_MS = 30000;
export interface ExecutionLeaseClaim {
    ownerId: string;
    ownerKind: ExecutionLease['owner_kind'];
    epoch: number;
    leaseId: string;
}
export interface ExecutionLeaseStatus {
    state: 'unleased' | 'active' | 'stale' | 'handoff';
    stale: boolean;
    heartbeat_age_ms: number | null;
    lease: Omit<ExecutionLease, 'lease_id'> | null;
    lease_id_hash: string | null;
}
export declare function hashExecutionLeaseId(leaseId: string): string;
export declare function mintExecutionLeaseId(): string;
export declare function executionLeaseClaim(lease: ExecutionLease): ExecutionLeaseClaim;
/** Require the complete execution lease tuple and reject an old owner after takeover. */
export declare function assertExecutionLease(lease: ExecutionLease | null, claim: ExecutionLeaseClaim, options?: {
    allowHandoff?: boolean;
}): ExecutionLease;
export declare function isExecutionLeaseStale(lease: ExecutionLease, now?: Date, staleAfterMs?: number): boolean;
export declare function describeExecutionLease(lease: ExecutionLease | null, now?: Date, staleAfterMs?: number): ExecutionLeaseStatus;
/**
 * Verify a claim against a session lease. Returns a conflict message (for the
 * caller to print on stderr before exiting 1) or null when the claim passes.
 *
 * A lease is inert unless it exists and names an owner: `null` lease or
 * `owner === null` short-circuits to null (no verification, no effect). When
 * active, each set field of the lease must match the claim:
 *   - `owner` ≠ executionOwner  → conflict (mirrors the retired ralph engine's execution_owner check)
 *   - `id`    ≠ leaseId         → conflict (mirrors the retired ralph engine's lease_id check)
 *   - `epoch` ≠ ownerEpoch      → conflict (epoch fencing; an active lease
 *                                 requires the complete owner/epoch/id claim)
 */
export declare function checkLease(lease: OrchestrationLease | null | undefined, claim: LeaseClaim): string | null;
/**
 * The lease value after a claim, or null when nothing should be written.
 * Originally modelled on the retired ralph cmd-next claim path (removed;
 * `m.execution_owner = ...` after the step goes
 * live): a claim is written only when the caller supplies an executionOwner and
 * either the session has no active lease owner (fresh claim) or the existing
 * owner matches (renewal). A conflicting claim never reaches here — checkLease
 * rejects it upstream. An active owner always requires a complete epoch/id
 * fencing tuple; omitted fields are rejected instead of inherited or defaulted.
 *
 * Returns null (no write) when no executionOwner is supplied, so `run next`
 * without `--execution-owner` leaves a leaseless session leaseless.
 */
export declare function claimLease(lease: OrchestrationLease | null | undefined, claim: LeaseClaim): OrchestrationLease | null;
//# sourceMappingURL=lease.d.ts.map