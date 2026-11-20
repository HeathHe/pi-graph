import { type RepositoryMutationContext } from '../repository/context.js';
import type { BoundQuarantine } from '../utils/lifecycle-fs-wire.js';
type ContentHash = string | null;
export interface KnowhowLifecycleResult {
    success: boolean;
    schema_version?: 'knowhow-supersede-result/1.0';
    operation?: 'supersede';
    oldId?: string;
    newId?: string;
    replayed?: boolean;
    error?: string;
    code?: string;
}
export interface KnowhowEvolutionLink {
    id: string;
    filename: string;
    path: string;
    title: string;
    deprecated: boolean;
    current: boolean;
    broken: boolean;
    supersedes: string[];
    supersededBy: string | null;
}
export interface LifecycleFaultOptions {
    ownerGeneration?: string;
    /** Host-resolved authority for an explicitly linked lifecycle target. */
    repositoryContext?: RepositoryMutationContext;
    /** Internal recursion fence set only while authority locks are held. */
    authorityValidated?: boolean;
    afterTarget?: (path: string, completedTargets: number) => void;
    beforeTargetCheckpoint?: (path: string, completedTargets: number) => void;
    afterTargetQuarantine?: (path: string, quarantine: BoundQuarantine) => void;
    beforeLockDelete?: (phase: 'reclaim' | 'release', lockPath: string) => void;
}
interface LifecycleIntentTarget {
    id: string;
    path: string;
    beforeHash: ContentHash;
    afterHash: ContentHash;
    beforeBase64: string | null;
    afterBase64: string | null;
}
export interface LifecycleIntent {
    schema_version: 'knowhow-lifecycle-intent/1.0';
    operation: 'supersede';
    oldId: string;
    newId: string;
    targets: LifecycleIntentTarget[];
}
export interface KnowhowSnapshotTarget {
    path: string;
    beforeHash: ContentHash;
    beforeBase64: string | null;
    afterHash: ContentHash;
    expectedAbsent: boolean;
}
export interface KnowhowLifecycleSnapshot {
    schema_version: 'knowhow-lifecycle-snapshot/1.0';
    createdAt: string;
    sealedAt: string | null;
    oldId: string;
    newId: string;
    targets: KnowhowSnapshotTarget[];
}
export interface CreateKnowhowSnapshotOptions {
    oldId: string;
    newId: string;
    newPath: string;
    includeRelative?: string[];
    out: string;
}
export interface RestoreTargetState {
    path: string;
    beforeHash: ContentHash;
    afterHash: ContentHash;
    restoreHash: ContentHash;
    completed: boolean;
    quarantine?: BoundQuarantine;
}
export interface KnowhowRestoreIntent {
    schema_version: 'knowhow-restore-intent/1.0';
    requestId: string;
    operation: 'restore';
    status: 'pending' | 'completed' | 'conflict';
    subject: string;
    claimedRun: string;
    requestHash: string;
    targets: RestoreTargetState[];
    conflict?: {
        path: string;
        expectedHash: ContentHash;
        actualHash: ContentHash;
    };
}
export interface KnowhowRestoreReceipt {
    schema_version: 'knowhow-restore-receipt/1.0';
    requestId: string;
    operation: 'restore';
    status: 'completed' | 'conflict';
    subject: string;
    claimedRun: string;
    requestHash: string;
    resultHash: string;
    targets: RestoreTargetState[];
    conflict?: {
        path: string;
        expectedHash: ContentHash;
        actualHash: ContentHash;
    };
}
export interface RestoreKnowhowOptions extends LifecycleFaultOptions {
    claimedRun?: string;
}
export interface RestoreKnowhowResult {
    success: boolean;
    replayed: boolean;
    intent: KnowhowRestoreIntent;
    receipt?: KnowhowRestoreReceipt;
    error?: string;
    code?: string;
}
type LifecyclePathExpectation = 'existing-file' | 'existing-directory' | 'write-target' | 'delete-target';
/**
 * Expand 8.3 names without following junctions/symlinks.
 * Accumulator starts at parse(abs).root so Windows UNC (`\\server\share\`) is kept.
 */
export declare function canonicalizeExistingPrefix(path: string): string;
export declare function resolveLifecyclePath(projectRoot: string, input: string, expected: LifecyclePathExpectation): string;
export declare function setFrontmatterValues(raw: string, values: Record<string, string | string[]>): string;
export declare function assertLifecycleIntent(projectRoot: string, value: LifecycleIntent): void;
export declare function recoverKnowhowLifecycleIntent(projectRoot: string, options?: LifecycleFaultOptions): KnowhowLifecycleResult;
export declare function supersedeKnowhowEntry(projectRoot: string, oldId: string, newId: string, options?: LifecycleFaultOptions): KnowhowLifecycleResult;
export declare function getKnowhowEvolutionChain(projectRoot: string, id: string): KnowhowEvolutionLink[];
export declare function createKnowhowLifecycleSnapshot(projectRoot: string, options: CreateKnowhowSnapshotOptions): KnowhowLifecycleSnapshot;
export declare function sealKnowhowLifecycleSnapshot(projectRoot: string, snapshotPath: string): KnowhowLifecycleSnapshot;
export declare function parseRestoreIntent(value: unknown, snapshot: KnowhowLifecycleSnapshot, expectedSubject: string): KnowhowRestoreIntent;
export declare function restoreKnowhowLifecycleSnapshot(projectRoot: string, snapshotPathInput: string, options?: RestoreKnowhowOptions): RestoreKnowhowResult;
export declare function recoverKnowhowRestoreIntent(projectRoot: string, snapshotPath: string, options?: RestoreKnowhowOptions): RestoreKnowhowResult;
export {};
//# sourceMappingURL=knowhow-lifecycle.d.ts.map