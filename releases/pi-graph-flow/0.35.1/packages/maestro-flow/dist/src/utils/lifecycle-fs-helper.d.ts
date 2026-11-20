import type { BoundLock, BoundQuarantine, BoundRead, HelperFailureCode, LifecycleGeneration } from './lifecycle-fs-wire.js';
import { LIFECYCLE_FS_HELPER_PROTOCOL } from './lifecycle-fs-wire.js';
export interface VerifiedLifecycleFsHelper {
    path: string;
    target: string;
    sha256: string;
    protocol: typeof LIFECYCLE_FS_HELPER_PROTOCOL;
    sourceSha: string;
    workflowRunId: number;
}
export declare class LifecycleFsHelperError extends Error {
    readonly code: HelperFailureCode;
    readonly nativeStatus: string | null;
    constructor(code: HelperFailureCode, message: string, nativeStatus?: string | null);
}
export declare function verifyLifecycleFsHelperBinary(options?: {
    packageRoot?: string;
    platform?: NodeJS.Platform;
    arch?: string;
}): VerifiedLifecycleFsHelper;
export declare function withVerifiedLifecycleFsHelper<T>(action: () => T): T;
export declare function readLifecycleFileBound(projectRoot: string, relativePath: string): BoundRead;
export declare function replaceLifecycleFileBound(projectRoot: string, relativePath: string, bytes: Buffer, expected: LifecycleGeneration | null, ownerGeneration: string): LifecycleGeneration;
export declare function acquireLifecycleLockBound(projectRoot: string, lockRelativePath: string, owner: {
    pid: number;
    token: string;
    ownerGeneration: string;
}, staleAfterMs: number): BoundLock;
export declare function quarantineLifecycleFileBound(projectRoot: string, relativePath: string, expectedSha256: string, requestId: string, ownerGeneration: string): BoundQuarantine;
export declare function recoverLifecycleQuarantineBound(projectRoot: string, quarantine: BoundQuarantine, decision: 'restore' | 'commit'): 'restored' | 'committed' | 'replaced';
export declare function compareReleaseLifecycleLock(projectRoot: string, lock: BoundLock): 'released' | 'missing' | 'replaced';
//# sourceMappingURL=lifecycle-fs-helper.d.ts.map